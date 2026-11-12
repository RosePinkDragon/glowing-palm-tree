import { useState } from 'react';
import { View } from 'react-native';
import * as Linking from 'expo-linking';
import { MarketButton, MarketCard, MarketField, MarketText } from './components';
import { messageOf, useMarket } from './useMarket';

type Market = ReturnType<typeof useMarket>;
export function AuthPanel({ market }: { market: Market }) {
  const [mode, setMode] = useState<'signin' | 'signup' | 'reset'>('signin');
  const [email, setEmail] = useState(''); const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false); const [message, setMessage] = useState('');
  const submit = async () => {
    setBusy(true); setMessage('');
    try {
      const redirect = Linking.createURL('/');
      if (market.recovery) { await market.services.auth.updatePassword(password); market.setRecovery(false); setMessage('Password updated.'); }
      else if (mode === 'reset') { await market.services.auth.resetPassword(email.trim(), redirect); setMessage('If the account exists, a reset link has been sent.'); }
      else if (mode === 'signup') { const result = await market.services.auth.signUp(email.trim(), password, redirect); setMessage(result.confirmationRequired ? 'Check your email to confirm your account.' : 'Your account is ready.'); }
      else await market.services.auth.signIn(email.trim(), password);
    } catch (e) { setMessage(messageOf(e)); } finally { setBusy(false); }
  };
  if (market.services.mode === 'demo') return <MarketCard><MarketText variant="heading">Account unavailable</MarketText><MarketText>Accounts and ordering are not available in this sample menu.</MarketText></MarketCard>;
  if (market.session && !market.recovery) return <MarketCard><MarketText variant="heading">Your account</MarketText><MarketText>{market.session.user.email ?? 'Signed in'}</MarketText>{!market.services.persistenceAvailable() ? <MarketText variant="muted">This session is stored only for this visit because device storage is unavailable.</MarketText> : null}<MarketButton label="Sign out" variant="secondary" onPress={() => { void market.services.auth.signOut().catch(e => setMessage(messageOf(e))); }} />{message ? <MarketText>{message}</MarketText> : null}</MarketCard>;
  return <MarketCard><MarketText variant="heading">{market.recovery ? 'Set a new password' : mode === 'signup' ? 'Create an account' : mode === 'reset' ? 'Reset password' : 'Sign in'}</MarketText>
    {!market.recovery ? <MarketField label="Email" value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" autoComplete="email" /> : null}
    {mode !== 'reset' || market.recovery ? <MarketField label="Password" value={password} onChangeText={setPassword} secureTextEntry autoCapitalize="none" /> : null}
    {message ? <MarketText>{message}</MarketText> : null}
    <MarketButton label={busy ? 'Please wait…' : market.recovery ? 'Update password' : mode === 'signup' ? 'Create account' : mode === 'reset' ? 'Send reset link' : 'Sign in'} disabled={busy} onPress={() => void submit()} />
    {!market.recovery ? <View style={{ gap: 8 }}><MarketButton variant="secondary" label={mode === 'signup' ? 'Already have an account? Sign in' : 'Create an account'} onPress={() => { setMode(mode === 'signup' ? 'signin' : 'signup'); setMessage(''); }} /><MarketButton variant="secondary" label={mode === 'reset' ? 'Back to sign in' : 'Forgot password?'} onPress={() => { setMode(mode === 'reset' ? 'signin' : 'reset'); setMessage(''); }} /></View> : null}
  </MarketCard>;
}
