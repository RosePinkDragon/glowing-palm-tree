import { useEffect, useState } from 'react';
import { Platform, Text, View } from 'react-native';
import * as Linking from 'expo-linking';
import { MarketButton, MarketCard, MarketField, MarketText } from './components';
import { messageOf, useMarket } from './useMarket';
import { useMarketTheme } from './theme';
import { sameIdentity } from './checkout-state';
import { webRedirectUrl } from './auth-callback';

type Market = ReturnType<typeof useMarket>;
export function AuthPanel({ market }: { market: Market }) {
  const { colors } = useMarketTheme();
  const [mode, setMode] = useState<'signin' | 'signup' | 'reset'>('signin');
  const [email, setEmail] = useState(''); const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false); const [message, setMessage] = useState(''); const [failed, setFailed] = useState(false);
  useEffect(() => { setEmail(''); setPassword(''); setMessage(''); }, [market.identityVersion]);
  const submit = async () => {
    const started = market.identity.current; const submittedPassword = password; const submittedEmail = email.trim();
    setPassword(''); setBusy(true); setMessage(''); setFailed(false);
    try {
      const redirect = Platform.OS === 'web' && typeof window !== 'undefined' ? webRedirectUrl(window.location.href) : Linking.createURL('/');
      if (market.recovery) { await market.services.auth.updatePassword(submittedPassword); if (sameIdentity(started, market.identity.current)) { market.setRecovery(false); setMessage('Password updated.'); } }
      else if (mode === 'reset') { await market.services.auth.resetPassword(submittedEmail, redirect); if (sameIdentity(started, market.identity.current)) setMessage('If the account exists, a reset link has been sent.'); }
      else if (mode === 'signup') { const result = await market.services.auth.signUp(submittedEmail, submittedPassword, redirect); if (sameIdentity(started, market.identity.current)) setMessage(result.confirmationRequired ? 'Check your email to confirm your account.' : 'Your account is ready.'); }
      else await market.services.auth.signIn(submittedEmail, submittedPassword);
    } catch (e) { if (sameIdentity(started, market.identity.current)) { setFailed(true); setMessage(messageOf(e)); } } finally { setBusy(false); }
  };
  const feedback = message ? <Text accessibilityRole={failed ? 'alert' : undefined} accessibilityLiveRegion="polite" role={failed ? 'alert' : 'status'} style={{ color: failed ? colors.danger : colors.ink, fontSize: 15, lineHeight: 23 }}>{message}</Text> : null;
  if (market.services.mode === 'demo') return <MarketCard><MarketText variant="heading">Account unavailable</MarketText><MarketText>Accounts and ordering are not available in this sample menu.</MarketText></MarketCard>;
  if (market.session && !market.recovery) return <MarketCard><MarketText variant="heading">Your account</MarketText><MarketText>{market.session.user.email ?? 'Signed in'}</MarketText>{!market.services.persistenceAvailable() ? <MarketText variant="muted">This session is stored only for this visit because device storage is unavailable.</MarketText> : null}<NotificationPreferences settings={market.preferences} /><MarketButton label="Sign out" variant="secondary" disabled={market.preferences.busy} onPress={() => { void market.preferences.signOut().catch(e => { setFailed(true); setMessage(messageOf(e)); }); }} />{feedback}</MarketCard>;
  return <MarketCard><MarketText variant="heading">{market.recovery ? 'Set a new password' : mode === 'signup' ? 'Create an account' : mode === 'reset' ? 'Reset password' : 'Sign in'}</MarketText>
    {!market.recovery ? <MarketField label="Email" value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" autoComplete="email" /> : null}
    {mode !== 'reset' || market.recovery ? <MarketField label="Password" value={password} onChangeText={setPassword} secureTextEntry autoCapitalize="none" /> : null}
    {feedback}
    <MarketButton label={busy ? 'Please wait…' : market.recovery ? 'Update password' : mode === 'signup' ? 'Create account' : mode === 'reset' ? 'Send reset link' : 'Sign in'} disabled={busy} onPress={() => void submit()} />
    {!market.recovery ? <View style={{ gap: 8 }}><MarketButton variant="secondary" label={mode === 'signup' ? 'Already have an account? Sign in' : 'Create an account'} onPress={() => { setMode(mode === 'signup' ? 'signin' : 'signup'); setPassword(''); setMessage(''); }} /><MarketButton variant="secondary" label={mode === 'reset' ? 'Back to sign in' : 'Forgot password?'} onPress={() => { setMode(mode === 'reset' ? 'signin' : 'reset'); setPassword(''); setMessage(''); }} /></View> : null}
  </MarketCard>;
}

import type { useNotificationPreferences } from './useNotificationPreferences';

export function NotificationPreferences({ settings }: { settings: ReturnType<typeof useNotificationPreferences> }) {
  return <View style={{ gap: 12 }}>
    <MarketText variant="heading">Your preferences</MarketText>
    <MarketText>Help us improve the app with basic app usage information.</MarketText>
    <MarketButton variant="secondary" disabled={!settings.ready || settings.busy} label={settings.prefs.analytics ? 'Turn analytics off' : 'Turn analytics on'} onPress={() => void settings.setAnalytics(!settings.prefs.analytics)} />
    {settings.analyticsMessage ? <MarketText>{settings.analyticsMessage}</MarketText> : null}
    <MarketText>Receive notifications about updates to your orders.</MarketText>
    <MarketButton variant="secondary" disabled={!settings.ready || settings.busy} label={settings.prefs.push ? 'Turn notifications off' : 'Turn notifications on'} onPress={() => settings.setPush(!settings.prefs.push)} />
    {settings.pushMessage ? <MarketText>{settings.pushMessage}</MarketText> : null}
  </View>;
}
