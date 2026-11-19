import { useEffect, useRef, useState, type ComponentRef, type ReactNode } from 'react';
import { Platform, Pressable, Text, TextInput, View } from 'react-native';
import { RESEND_COOLDOWN_SECONDS, codeFieldValue, cooldownDeadline, cooldownRemaining, formatCountdown, formatPhone, isCompleteCode, isOtpErrorCode, normalizeIndianMobile, otpErrorCopy, phoneFieldError, phoneFieldValue, type OtpErrorCode } from '@market/core';
import { ServiceError } from '@market/services';
import { MarketButton, MarketCard, MarketField, MarketText } from './components';
import { messageOf, useMarket } from './useMarket';
import { useMarketFonts, useMarketTheme } from './theme';
import { sameIdentity } from './checkout-state';

type Market = ReturnType<typeof useMarket>;
/** `onLegal` opens the terms or privacy page; apps without those pages (the owners' apps) omit it and the notice stays plain text. */
export function AuthPanel({ market, accountActions, onLegal }: { market: Market; accountActions?: ReactNode; onLegal?: (path: '/terms' | '/privacy') => void }) {
  const { colors } = useMarketTheme();
  const [message, setMessage] = useState(''); const [failed, setFailed] = useState(false);
  useEffect(() => { setMessage(''); }, [market.identityVersion]);
  const feedback = message ? <Text accessibilityRole={failed ? 'alert' : undefined} accessibilityLiveRegion="polite" role={failed ? 'alert' : 'status'} style={{ color: failed ? colors.danger : colors.ink, fontSize: 15, lineHeight: 23 }}>{message}</Text> : null;
  if (market.services.mode === 'demo') return <MarketCard><MarketText variant="heading">Account unavailable</MarketText><MarketText>Accounts and ordering are not available in this sample menu.</MarketText></MarketCard>;
  if (market.session && !market.recovery) return <MarketCard><MarketText variant="heading">Your account</MarketText><MarketText>{market.session.user.email ?? 'Signed in'}</MarketText>{!market.services.persistenceAvailable() ? <MarketText variant="muted">This session is stored only for this visit because device storage is unavailable.</MarketText> : null}<NotificationPreferences settings={market.preferences} /><MarketButton label="Sign out" variant="secondary" disabled={market.preferences.busy} onPress={() => { void market.preferences.signOut().catch(e => { setFailed(true); setMessage(messageOf(e)); }); }} />{accountActions}{feedback}</MarketCard>;
  // Everyone signs in with a WhatsApp code (#50): customers (a new number creates the account) and owners (50-C, no email form).
  return <PhoneLogin market={market} onLegal={onLegal} />;
}

/** The web CAPTCHA widget is only rendered when EXPO_PUBLIC_TURNSTILE_SITE_KEY is set at build time (public, never a secret); without it the screens skip CAPTCHA entirely and Supabase must have CAPTCHA protection off. Native builds never show it (#50 is web-first). */
const turnstileSiteKey = (process.env.EXPO_PUBLIC_TURNSTILE_SITE_KEY ?? '').trim();
type TurnstileApi = { render: (el: HTMLElement, options: Record<string, unknown>) => string; reset: (id?: string) => void; remove: (id?: string) => void };
let turnstileScript: Promise<TurnstileApi> | null = null;
function loadTurnstile(): Promise<TurnstileApi> {
  const ready = () => (window as unknown as { turnstile?: TurnstileApi }).turnstile;
  turnstileScript ??= new Promise((resolve, reject) => {
    const found = ready(); if (found) { resolve(found); return; }
    const script = document.createElement('script'); script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'; script.async = true;
    script.onload = () => { const api = ready(); if (api) resolve(api); else reject(new Error('Turnstile did not load')); };
    script.onerror = () => { turnstileScript = null; reject(new Error('Turnstile did not load')); };
    document.head.appendChild(script);
  });
  return turnstileScript;
}
/** One widget for the whole sign-in card; a token is single-use, so the parent bumps `resetKey` after every code request. */
function Captcha({ onToken, onFailed, resetKey }: { onToken: (token: string) => void; onFailed: () => void; resetKey: number }) {
  const host = useRef<unknown>(null); const widget = useRef<{ api: TurnstileApi; id: string } | null>(null);
  const callbacks = useRef({ onToken, onFailed }); callbacks.current = { onToken, onFailed };
  useEffect(() => {
    let active = true;
    loadTurnstile().then(api => {
      if (!active || !host.current) return;
      const id = api.render(host.current as HTMLElement, { sitekey: turnstileSiteKey, appearance: 'interaction-only', callback: (token: string) => callbacks.current.onToken(token), 'expired-callback': () => callbacks.current.onToken(''), 'error-callback': () => callbacks.current.onFailed() });
      widget.current = { api, id };
    }).catch(() => { if (active) callbacks.current.onFailed(); });
    return () => { active = false; if (widget.current) { widget.current.api.remove(widget.current.id); widget.current = null; } };
  }, []);
  useEffect(() => { if (resetKey > 0) widget.current?.api.reset(widget.current.id); }, [resetKey]);
  return <View ref={host as never} accessibilityLabel="Security check" style={{ alignItems: 'flex-start' }} />;
}

const hiddenText = { position: 'absolute', width: 1, height: 1, overflow: 'hidden', opacity: 0 } as const;
type Stage = 'phone' | 'code';
/** Customers and owners sign in with a phone number and a one-time code sent on WhatsApp; for customers a new number creates the account (#50). */
function PhoneLogin({ market, onLegal }: { market: Market; onLegal?: (path: '/terms' | '/privacy') => void }) {
  const { colors } = useMarketTheme(); const fonts = useMarketFonts(); const { services } = market;
  // Owners use the same screens with a server that answers identically for owners and everyone else, so nothing here may reveal which a number is.
  const owner = services.audience === 'admin';
  const [stage, setStage] = useState<Stage>('phone');
  const [field, setField] = useState(''); const [fieldError, setFieldError] = useState('');
  const [phone, setPhone] = useState(''); const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false); const [errorCode, setErrorCode] = useState<OtpErrorCode | null>(null);
  const [cooldown, setCooldown] = useState<{ phone: string; until: number } | null>(null); const [now, setNow] = useState(() => Date.now());
  const [announce, setAnnounce] = useState('');
  const [captcha, setCaptcha] = useState(''); const [captchaFailed, setCaptchaFailed] = useState(false); const [captchaReset, setCaptchaReset] = useState(0);
  const useCaptcha = Platform.OS === 'web' && turnstileSiteKey !== '';
  const codeInput = useRef<ComponentRef<typeof TextInput>>(null); const alive = useRef(true); const working = useRef(false); const verifyRun = useRef(0);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { setStage('phone'); setField(''); setFieldError(''); setPhone(''); setCode(''); setErrorCode(null); setCooldown(null); setAnnounce(''); }, [market.identityVersion]);
  useEffect(() => { if (stage === 'code') { const t = setTimeout(() => codeInput.current?.focus(), 50); return () => clearTimeout(t); } }, [stage]);
  const activeUntil = cooldown && (stage === 'code' ? cooldown.phone === phone : cooldown.phone === normalizeIndianMobile(field)) ? cooldown.until : 0;
  const remaining = cooldownRemaining(activeUntil, now);
  useEffect(() => {
    if (!cooldown || cooldownRemaining(cooldown.until, Date.now()) === 0) return;
    const tick = setInterval(() => { const t = Date.now(); setNow(t); if (cooldownRemaining(cooldown.until, t) === 0) { clearInterval(tick); setAnnounce('You can send a new code now.'); setErrorCode(current => current === 'RESEND_COOLDOWN' ? null : current); } }, 500);
    return () => clearInterval(tick);
  }, [cooldown]);
  const waitingForCaptcha = useCaptcha && !captcha && !captchaFailed;
  const send = async (target: string, moveOn: boolean) => {
    if (working.current) return; working.current = true; setBusy(true); setErrorCode(null); setFieldError('');
    const started = market.identity.current;
    try {
      if (owner) await services.auth.requestOwnerCode(target, useCaptcha ? captcha : undefined); else await services.auth.requestCode(target, useCaptcha ? captcha : undefined);
      if (!alive.current || !sameIdentity(started, market.identity.current)) return;
      const t = Date.now(); setNow(t); setCooldown({ phone: target, until: cooldownDeadline(t) }); setAnnounce(owner ? `If this number belongs to a restaurant owner, a code is on its way on WhatsApp. You can ask for another in ${RESEND_COOLDOWN_SECONDS} seconds.` : `Code sent on WhatsApp. You can ask for another in ${RESEND_COOLDOWN_SECONDS} seconds.`);
      setPhone(target); setCode(''); if (moveOn) setStage('code');
    } catch (e) {
      if (!alive.current || !sameIdentity(started, market.identity.current)) return;
      const failure = e instanceof ServiceError ? e : null; let next: OtpErrorCode = failure && isOtpErrorCode(failure.code) ? failure.code : 'GENERIC';
      if (owner && next === 'NOT_ON_WHATSAPP') next = 'GENERIC'; // never tell anyone whether a number is an owner's
      if (next === 'RESEND_COOLDOWN') { const wait = (failure?.cause as { retryAfterSeconds?: number | null } | undefined)?.retryAfterSeconds; const t = Date.now(); setNow(t); setCooldown({ phone: target, until: cooldownDeadline(t, wait ?? RESEND_COOLDOWN_SECONDS) }); }
      // A code was sent recently (for example before a reload): go to the code screen for this number, with the countdown, as after a successful request.
      if (next === 'RESEND_COOLDOWN' && moveOn) { setPhone(target); setCode(''); setStage('code'); }
      setErrorCode(next);
    } finally { working.current = false; if (alive.current) { setBusy(false); if (useCaptcha) { setCaptcha(''); setCaptchaReset(n => n + 1); } } }
  };
  const getCode = () => {
    if (busy || remaining > 0 || waitingForCaptcha || captchaFailed) return; // Enter must respect the same guards as the disabled button
    const target = normalizeIndianMobile(field); const problem = phoneFieldError(field);
    if (!target || problem) { setFieldError(problem); return; }
    void send(target, true);
  };
  const verify = async () => {
    if (working.current) return;
    if (!isCompleteCode(code)) { setErrorCode('WRONG_OR_EXPIRED_CODE'); codeInput.current?.focus(); return; }
    working.current = true; setBusy(true); setErrorCode(null); const started = market.identity.current; const run = verifyRun.current;
    try { await services.auth.verifyCode(phone, code); }
    catch (e) {
      if (!alive.current || !sameIdentity(started, market.identity.current) || run !== verifyRun.current) return; // the user already moved on (Change number)
      setErrorCode(e instanceof ServiceError && isOtpErrorCode(e.code) ? e.code : 'GENERIC'); setCode(''); codeInput.current?.focus();
    } finally { working.current = false; if (alive.current) setBusy(false); }
  };
  const changeNumber = () => { verifyRun.current++; setStage('phone'); setCode(''); setErrorCode(null); setFieldError(''); setField(phoneFieldValue(phone)); };
  const bold = fonts.bodyBold ? { fontFamily: fonts.bodyBold } : { fontWeight: '700' as const };
  const error = errorCode && errorCode !== 'RESEND_COOLDOWN' ? otpErrorCopy[errorCode] : errorCode ? `${otpErrorCopy.RESEND_COOLDOWN}${remaining > 0 ? ` You can try again in ${formatCountdown(remaining)}.` : ''}` : '';
  const errorBox = <View role="alert" accessibilityLiveRegion="polite" style={{ minHeight: error ? undefined : 0 }}>{error ? <Text style={{ color: colors.danger, fontSize: 15, lineHeight: 23 }}>{error}</Text> : null}</View>;
  const status = <View role="status" accessibilityLiveRegion="polite" style={hiddenText}><Text>{announce}</Text></View>;
  const resendWait = remaining > 0;
  const linkStyle = { color: colors.primary, fontSize: 14, lineHeight: 21, textDecorationLine: 'underline' as const, ...bold };
  const legalLink = (label: string, path: '/terms' | '/privacy') => <Pressable accessibilityRole="link" accessibilityLabel={label} onPress={() => onLegal?.(path)} onKeyDown={(e: { key?: string; preventDefault?: () => void }) => { if (e.key === 'Enter') { e.preventDefault?.(); onLegal?.(path); } }} style={{ minHeight: 44, justifyContent: 'center' }}><Text accessible={false} style={linkStyle}>{label}</Text></Pressable>;
  const plain = { color: colors.muted, fontSize: 14, lineHeight: 21 };
  // The owners' apps have no terms or privacy pages yet, so there the same line is plain text rather than dead links.
  const legal = <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 4 }}>
    <Text style={plain}>By continuing you agree to</Text>{onLegal ? legalLink('Terms', '/terms') : <Text style={plain}>Terms</Text>}<Text style={plain}>and</Text>{onLegal ? legalLink('Privacy policy', '/privacy') : <Text style={plain}>Privacy policy</Text>}
  </View>;
  return <MarketCard>
    {stage === 'phone' ? <>
      <MarketText variant="heading">{owner ? 'Sign in' : 'Log in or sign up'}</MarketText>
      <MarketText variant="muted">{owner ? 'Enter the WhatsApp number of your owner account. We\'ll send a one-time code to it.' : 'We\'ll send a one-time code to this number on WhatsApp.'}</MarketText>
      <View style={{ gap: 8 }}>
        <Text nativeID="otp-phone-label" style={{ color: colors.ink, fontSize: 15, ...bold }}>Mobile number</Text>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <View accessible={false} style={{ minHeight: 48, minWidth: 56, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.inputBorder, borderRadius: 12, backgroundColor: colors.tint, paddingHorizontal: 12 }}><Text style={{ color: colors.ink, fontSize: 16, ...bold }}>+91</Text></View>
          <TextInput accessibilityLabel="Mobile number" aria-labelledby="otp-phone-label" aria-describedby="otp-phone-error" value={field} onChangeText={value => { setField(phoneFieldValue(value)); setFieldError(''); setErrorCode(null); }} onSubmitEditing={getCode}
            placeholder="10-digit number" placeholderTextColor={colors.muted} keyboardType="phone-pad" inputMode="tel" autoComplete="tel-national" textContentType="telephoneNumber" maxLength={20} editable={!busy} returnKeyType="go"
            style={{ flex: 1, minWidth: 0, minHeight: 48, borderWidth: 1, borderColor: fieldError ? colors.danger : colors.inputBorder, borderRadius: 12, backgroundColor: colors.surface, color: colors.ink, paddingHorizontal: 14, fontSize: 18, letterSpacing: 1 }} />
        </View>
        <View nativeID="otp-phone-error" role="alert" accessibilityLiveRegion="polite">{fieldError ? <Text style={{ color: colors.danger, fontSize: 14, lineHeight: 21 }}>{fieldError}</Text> : null}</View>
      </View>
      {errorBox}
      {legal}
      {useCaptcha ? <Captcha onToken={token => { setCaptcha(token); if (token) setCaptchaFailed(false); }} onFailed={() => setCaptchaFailed(true)} resetKey={captchaReset} /> : null}
      {useCaptcha && (waitingForCaptcha || captchaFailed) ? <MarketText variant="muted">{captchaFailed ? 'The security check could not load. Check your connection, reload the page and try again.' : 'Checking that you are not a robot…'}</MarketText> : null}
      <MarketButton label={busy ? 'Sending…' : remaining > 0 ? `Get code in ${formatCountdown(remaining)}` : 'Get code'} disabled={busy || remaining > 0 || waitingForCaptcha || captchaFailed} onPress={getCode} />
      {owner ? null : <View style={{ backgroundColor: colors.tint, borderRadius: 14, padding: 14 }}><Text style={{ color: colors.ink, fontSize: 14, lineHeight: 21 }}>New here? Your number creates your account; there&apos;s no password to remember.</Text></View>}
    </> : <>
      <MarketText variant="heading">Enter the code</MarketText>
      <Text style={{ color: colors.muted, fontSize: 15, lineHeight: 23 }}>{owner ? 'If this number belongs to a restaurant owner, we\'ve sent a code on WhatsApp to ' : 'We sent a 6-digit code on WhatsApp to '}<Text style={{ color: colors.ink, ...bold }}>{formatPhone(phone)}</Text>.</Text>
      <Pressable accessibilityRole="button" accessibilityLabel={`Change number, currently ${formatPhone(phone)}`} onPress={changeNumber} style={{ minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start' }}><Text style={{ color: colors.primary, fontSize: 15, textDecorationLine: 'underline', ...bold }}>Change number</Text></Pressable>
      <View style={{ gap: 8 }}>
        <Text nativeID="otp-code-label" style={{ color: colors.ink, fontSize: 15, ...bold }}>6-digit code</Text>
        <TextInput ref={codeInput} accessibilityLabel="6-digit code" aria-labelledby="otp-code-label" value={code} onChangeText={value => { setCode(codeFieldValue(value)); setErrorCode(null); }} onSubmitEditing={() => void verify()}
          keyboardType="number-pad" inputMode="numeric" autoComplete="one-time-code" textContentType="oneTimeCode" maxLength={14} editable={!busy} returnKeyType="go" autoFocus placeholder="······" placeholderTextColor={colors.muted}
          style={{ minHeight: 56, borderWidth: errorCode === 'WRONG_OR_EXPIRED_CODE' ? 2 : 1, borderColor: errorCode === 'WRONG_OR_EXPIRED_CODE' ? colors.danger : colors.inputBorder, borderRadius: 12, backgroundColor: colors.surface, color: colors.ink, paddingHorizontal: 14, fontSize: 28, letterSpacing: 12, textAlign: 'center', ...(fonts.bodyBold ? { fontFamily: fonts.bodyBold } : { fontWeight: '700' as const }) }} />
      </View>
      {errorBox}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 6 }}>
        <Text style={{ color: colors.muted, fontSize: 15, lineHeight: 23 }}>Didn&apos;t get it?</Text>
        {resendWait ? <Text style={{ color: colors.ink, fontSize: 15, lineHeight: 23 }}>You can resend in <Text style={bold}>{formatCountdown(remaining)}</Text></Text>
          : <Pressable accessibilityRole="button" disabled={busy || waitingForCaptcha} accessibilityState={{ disabled: busy || waitingForCaptcha }} onPress={() => void send(phone, false)} style={{ minHeight: 44, justifyContent: 'center' }}><Text style={{ color: colors.primary, fontSize: 15, textDecorationLine: 'underline', opacity: busy || waitingForCaptcha ? 0.5 : 1, ...bold }}>Send a new code</Text></Pressable>}
      </View>
      {useCaptcha ? <Captcha onToken={token => { setCaptcha(token); if (token) setCaptchaFailed(false); }} onFailed={() => setCaptchaFailed(true)} resetKey={captchaReset} /> : null}
      {useCaptcha && captchaFailed ? <MarketText variant="muted">The security check could not load. Reload the page and try again.</MarketText> : null}
      <MarketButton label={busy ? 'Please wait…' : 'Verify and continue'} disabled={busy} onPress={() => void verify()} />
      <View style={{ backgroundColor: colors.tint, borderRadius: 14, padding: 14 }}><Text style={{ color: colors.ink, fontSize: 14, lineHeight: 21 }}>Codes work for 10 minutes. If yours has expired, we&apos;ll say so here and you can send a new one.</Text></View>
    </>}
    {status}
  </MarketCard>;
}

import type { useNotificationPreferences } from './useNotificationPreferences';

export function NotificationPreferences({ settings }: { settings: ReturnType<typeof useNotificationPreferences> }) {
  return <View style={{ gap: 12 }}>
    <MarketText variant="heading">Your preferences</MarketText>
    <MarketText>Help us improve the app with basic app usage information.</MarketText>
    <MarketButton variant="secondary" disabled={!settings.ready || settings.busy} label={settings.prefs.analytics ? 'Turn analytics off' : 'Turn analytics on'} onPress={() => void settings.setAnalytics(!settings.prefs.analytics)} />
    <View accessibilityLiveRegion="polite" role="status"><MarketText>{settings.analyticsMessage}</MarketText></View>
    <MarketText>Receive notifications about updates to your orders.</MarketText>
    <MarketButton variant="secondary" disabled={!settings.ready || settings.busy} label={settings.prefs.push ? 'Turn notifications off' : 'Turn notifications on'} onPress={() => settings.setPush(!settings.prefs.push)} />
    <View accessibilityLiveRegion="polite" role="status"><MarketText>{settings.pushMessage}</MarketText></View>
  </View>;
}
