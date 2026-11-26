import { useEffect, useRef, useState, type ComponentRef } from 'react';
import { AccessibilityInfo, findNodeHandle, Modal, Platform, ScrollView, Text, TextInput, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { businesses } from '@market/core';
import { MarketButton, MarketField, MarketStatus } from './components';
import { sameIdentity } from './checkout-state';
import { initialsOf, needsNameStep, profileFailure, validateProfileName, verifiedPhoneDisplay } from './profile-model';
import { useMarketFonts, useMarketTheme } from './theme';
import type { useMarket } from './useMarket';

type Market = ReturnType<typeof useMarket>;
type Input = ComponentRef<typeof TextInput>;

function focusNode(node: unknown) {
  if (Platform.OS === 'web') (node as HTMLElement | null)?.focus?.();
  else { const handle = findNodeHandle(node as never); if (handle != null) AccessibilityInfo.setAccessibilityFocus(handle); }
}

/**
 * The name form shared by Edit profile and the first-login name step. The text starts from `initial` once; later profile refreshes
 * never replace what the customer has typed. Validation is the same trimmed 1 to 120 rule as the service and the database.
 */
function useNameForm(market: Market, initial: string, onSaved?: () => void) {
  const [value, setValue] = useState(initial), [typed, setTyped] = useState(false);
  const [fieldError, setFieldError] = useState(''), [failure, setFailure] = useState(''), [saving, setSaving] = useState(false), [saved, setSaved] = useState(false);
  const field = useRef<Input | null>(null), alert = useRef<ComponentRef<typeof Text>>(null);
  useEffect(() => { if (!typed) setValue(initial); }, [initial, typed]);
  const change = (next: string) => { setTyped(true); setValue(next); setFieldError(''); setFailure(''); setSaved(false); };
  // Focus moves to the error once it is on screen (the button is disabled while saving, so the focus is lost until the save ends).
  const [focusOn, setFocusOn] = useState<{ target: 'field' | 'alert'; n: number } | null>(null);
  useEffect(() => { if (focusOn && !saving) focusNode(focusOn.target === 'field' ? field.current : alert.current); }, [focusOn, saving]);
  const focusSoon = (target: 'field' | 'alert') => setFocusOn(current => ({ target, n: (current?.n ?? 0) + 1 }));
  const submit = async () => {
    if (saving) return;
    const checked = validateProfileName(value);
    if (checked.error) { setFieldError(checked.error); setSaved(false); focusSoon('field'); return; }
    const started = market.identity.current;
    setSaving(true); setFailure(''); setSaved(false);
    try {
      await market.profile.save(checked.name);
      if (!sameIdentity(started, market.identity.current)) return; // another account is signed in now: show nothing from this save
      setTyped(false); setValue(checked.name); setSaved(true); onSaved?.();
    } catch (error) {
      if (!sameIdentity(started, market.identity.current)) return;
      const problem = profileFailure(error);
      if (problem.kind === 'name') { setFieldError(problem.message); focusSoon('field'); }
      else { setFailure(problem.message); focusSoon('alert'); }
    } finally { setSaving(false); }
  };
  return { value, change, fieldError, failure, saving, saved, submit, field, alert };
}

function FailureText({ text, node }: { text: string; node: React.RefObject<ComponentRef<typeof Text> | null> }) {
  const { colors } = useMarketTheme();
  return text ? <Text ref={node} accessibilityRole="alert" accessibilityLiveRegion="polite" {...({ tabIndex: -1 } as object)} style={{ color: colors.danger, fontSize: 15, lineHeight: 23 }}>{text}</Text> : null;
}

/** Edit profile (#45): the customer's name, saved to the account they share across both apps, and their verified number (read-only). */
export function CustomerProfile({ market, onDone }: { market: Market; onDone: () => void }) {
  const { colors, name: restaurant, businessId } = useMarketTheme(); const fonts = useMarketFonts(); const ammu = businessId === 'ammu-sammu';
  const profile = market.profile, ensure = profile.ensure, userId = market.session?.user.id;
  useEffect(() => { void ensure(); }, [ensure, userId]);
  const saved = profile.profile?.fullName ?? '';
  const form = useNameForm(market, saved);
  const phone = verifiedPhoneDisplay(market.session?.user.phone);
  const other = Object.values(businesses).map(business => business.name).find(value => value !== restaurant) ?? restaurant;
  const initials = initialsOf(profile.profile?.fullName ?? '');
  const heading = fonts.heading ? { fontFamily: fonts.heading } : { fontWeight: '700' as const };
  if (profile.status === 'idle' || profile.status === 'loading') return <MarketStatus kind="loading" title="Loading your profile" />;
  if (profile.status === 'error') return <MarketStatus kind="error" title="We couldn't load your profile" message="Check your connection, then try again." action={<MarketButton label="Retry" onPress={() => void profile.reload()} />} />;
  return <View style={{ gap: 18 }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
      <View testID="profile-avatar" accessible={false} aria-hidden style={{ width: 60, height: 60, borderRadius: 30, backgroundColor: ammu ? colors.tint : colors.band, alignItems: 'center', justifyContent: 'center' }}><Text style={{ color: ammu ? colors.primary : colors.bandAccent, fontSize: 22, ...heading }}>{initials}</Text></View>
      <Text style={{ flex: 1, color: colors.muted, fontSize: 15, lineHeight: 23 }}>Your name and number go to the restaurant with each order so the rider can reach you. The same profile works in the {other} app.</Text>
    </View>
    <MarketField inputRef={form.field} label="Full name" value={form.value} onChangeText={form.change} error={form.fieldError} autoComplete="name" textContentType="name" maxLength={200} onSubmitEditing={() => void form.submit()} returnKeyType="done" />
    <MarketField label="Mobile number" value={phone || 'Phone not added'} editable={false} />
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
      <Text style={{ color: colors.positive, fontSize: 14, fontWeight: '700' }}>{phone ? 'Verified' : ''}</Text>
      <View accessibilityRole="button" accessibilityLabel="Change number, coming soon" accessibilityState={{ disabled: true }} aria-disabled style={{ minHeight: 44, justifyContent: 'center', opacity: 0.6, marginLeft: 'auto' }}><Text style={{ color: colors.muted, fontSize: 14 }}>Change number · coming soon</Text></View>
    </View>
    <FailureText text={form.failure} node={form.alert} />
    <View role="status" accessibilityLiveRegion="polite">{form.saved ? <Text style={{ color: colors.positive, fontSize: 15, fontWeight: '700' }}>Your profile is saved.</Text> : null}</View>
    <MarketButton label={form.saving ? 'Saving…' : 'Save changes'} disabled={form.saving} onPress={() => void form.submit()} />
    <MarketButton label="Done" variant="secondary" disabled={form.saving} onPress={onDone} />
  </View>;
}

/**
 * First login (#45): "What's your name?" before the menu, required, shown once per account. The profile is on the server, so the
 * other restaurant app already has it. Signing out is the only other way out.
 */
export function NameStep({ market, signOut }: { market: Market; signOut: () => Promise<void> }) {
  const { colors, name: restaurant, businessId } = useMarketTheme(); const fonts = useMarketFonts();
  const ammu = businessId === 'ammu-sammu';
  const title = useRef<ComponentRef<typeof Text>>(null);
  const form = useNameForm(market, '');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const other = Object.values(businesses).map(business => business.name).find(value => value !== restaurant) ?? restaurant;
  const heading = fonts.heading ? { fontFamily: fonts.heading } : { fontWeight: '700' as const };
  const leave = async () => { if (busy) return; setBusy(true); setError(''); try { await signOut(); } catch { setError('Could not sign out. Try again.'); } finally { setBusy(false); } };
  return <Modal visible animationType="none" onRequestClose={() => {}} onShow={() => focusNode(title.current)}>
    <SafeAreaProvider><SafeAreaView accessibilityViewIsModal style={{ flex: 1, backgroundColor: colors.background }}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ flexGrow: 1, padding: 24, gap: 16, width: '100%', maxWidth: 520, alignSelf: 'center' }}>
        <View accessible={false} aria-hidden style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: ammu ? colors.tint : colors.band, alignItems: 'center', justifyContent: 'center' }}><Text style={{ color: ammu ? colors.positive : colors.bandAccent, fontSize: 22 }}>✓</Text></View>
        {!ammu ? <Text style={{ color: colors.bandAccent, fontSize: 12, letterSpacing: 1.5, fontWeight: '700' }}>ALMOST DONE</Text> : null}
        <Text ref={title} accessibilityRole="header" aria-level={1} {...({ tabIndex: -1 } as object)} style={{ color: colors.ink, fontSize: 30, lineHeight: 38, ...heading }}>Welcome! What's your name?</Text>
        <Text style={{ color: colors.muted, fontSize: 16, lineHeight: 24 }}>It goes on your orders, so the rider knows who to ask for.</Text>
        <MarketField inputRef={form.field} label="Full name" value={form.value} onChangeText={form.change} error={form.fieldError} autoComplete="name" textContentType="name" maxLength={200} onSubmitEditing={() => void form.submit()} returnKeyType="done" />
        <FailureText text={form.failure} node={form.alert} />
        <MarketButton label={form.saving ? 'Saving…' : 'Continue'} disabled={form.saving || busy} onPress={() => void form.submit()} />
        <MarketButton label={busy ? 'Signing out…' : 'Sign out'} variant="secondary" disabled={form.saving || busy} onPress={() => void leave()} />
        {error ? <Text accessibilityRole="alert" style={{ color: colors.danger }}>{error}</Text> : null}
        <View style={{ flexGrow: 1 }} />
        <View style={{ padding: 14, borderRadius: 12, backgroundColor: colors.tint }}><Text style={{ color: colors.muted, fontSize: 14, lineHeight: 21 }}>Your account also works in the {other} app, so you won't need to set this up again there.</Text></View>
      </ScrollView>
    </SafeAreaView></SafeAreaProvider>
  </Modal>;
}

/** Renders the name step only for an account that has just signed in and has no name yet. */
export function NameGate({ market, signOut }: { market: Market; signOut: () => Promise<void> }) {
  return needsNameStep(market.profile) ? <NameStep key={market.identityVersion} market={market} signOut={signOut} /> : null;
}
