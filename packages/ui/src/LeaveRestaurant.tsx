import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import type { BusinessSlug } from '@market/core';
import type { CustomerRestaurantLink } from '@market/services';
import { MarketButton, MarketText } from './components';
import { AccessiblePanel, capturePanelFocus, restorePanelFocus } from './AccessiblePanel';
import { sameIdentity } from './checkout-state';
import { clearLeaveRequest, cleanupDecision, ensureLeaveRequest, leaveEffects, leaveFailure, leaveRequestIsFinal, leaveTarget, type LeaveFailure } from './leave-model';
import { useMarketTheme } from './theme';
import { preferenceKey } from './useNotificationPreferences';
import type { useMarket } from './useMarket';

type Market = ReturnType<typeof useMarket>;
/**
 * "Leave [restaurant]" (#52) in Account settings. Shown only while the customer is linked to
 * another restaurant too. The server leave comes first; this phone is only cleaned (and signed
 * out of this app) once the server receipt is in and still matches the relationship we left.
 */
export function LeaveRestaurant({ market, businessId, resetCart, signOut, onLeft }: { market: Market; businessId: BusinessSlug; resetCart: () => Promise<void>; signOut: () => Promise<void>; onLeft: (message: string) => void }) {
  const { colors, name } = useMarketTheme();
  const userId = market.session?.user.id ?? null;
  const backend = market.services.mode === 'backend';
  const [links, setLinks] = useState<CustomerRestaurantLink[] | null>(null);
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<LeaveFailure | null>(null);
  const [reload, setReload] = useState(0);
  const sending = useRef(false), trigger = useRef<HTMLElement | null>(null);
  const kept = useRef<{ generation: string; otherName: string } | null>(null);
  useEffect(() => {
    if (!userId || !backend || !market.authReady) { setLinks(null); return; }
    let active = true; const started = market.identity.current;
    void market.services.getMyRestaurants().then(rows => { if (active && sameIdentity(started, market.identity.current)) setLinks(rows); }).catch(() => { if (active) setLinks(null); });
    return () => { active = false; };
  }, [userId, backend, market.authReady, market.identityVersion, market.services, market.identity, reload]);
  const target = leaveTarget(links, businessId);
  if (target) kept.current = target;
  const close = useCallback(() => { setOpen(false); setFailure(null); restorePanelFocus(trigger.current); }, []);
  const confirm = async () => {
    const shown = kept.current;
    if (sending.current || !userId || !shown) return;
    sending.current = true; setBusy(true); setFailure(null);
    const started = market.identity.current, storage = AsyncStorage;
    try {
      const requestId = await ensureLeaveRequest(storage, businessId, userId, shown.generation, () => Crypto.randomUUID());
      const receipt = await market.services.leaveBusiness({ requestId, generation: shown.generation });
      if (!sameIdentity(started, market.identity.current)) return;
      const current = (await market.services.getMyRestaurants()).find(row => row.businessSlug === businessId);
      if (!sameIdentity(started, market.identity.current)) return;
      const decision = cleanupDecision(receipt, { slug: businessId, generation: shown.generation, requestId }, current);
      if (decision === 'superseded') { await clearLeaveRequest(storage, businessId, userId); setFailure({ message: `This changed, so we have refreshed it. Nothing was cleared on this phone.`, retry: false, refresh: true, signIn: false }); setReload(value => value + 1); return; }
      if (decision !== 'clean') throw new Error('Leave could not be confirmed');
      // Only now is anything removed from this phone; a failure here leaves the request ID so Retry replays the same receipt.
      await resetCart();
      await storage.removeItem(preferenceKey(businessId, 'customer', userId));
      await signOut();
      await clearLeaveRequest(storage, businessId, userId).catch(() => {});
      setOpen(false);
      onLeft(`You left ${name}. Your account stays for the ${shown.otherName} app.`);
    } catch (e) {
      if (!sameIdentity(started, market.identity.current)) return;
      if (leaveRequestIsFinal(e)) await clearLeaveRequest(storage, businessId, userId).catch(() => {});
      const next = leaveFailure(e, name); setFailure(next); if (next.refresh) setReload(value => value + 1);
    } finally { sending.current = false; setBusy(false); }
  };
  if (!target && !open) return null;
  const shown = target ?? kept.current;
  if (!shown) return null;
  const effects = leaveEffects(name, shown.otherName);
  return <View style={{ gap: 6, paddingTop: 12, borderTopWidth: 1, borderTopColor: colors.border }}>
    <MarketButton label={`Leave ${name}`} variant="secondary" disabled={busy || !target} onPress={() => { trigger.current = capturePanelFocus(); setFailure(null); setOpen(true); }} />
    <MarketText variant="muted">{`Your account stays for the ${shown.otherName} app`}</MarketText>
    {open ? <AccessiblePanel sheet title={`Leave ${name}?`} closeDisabled={busy} onClose={() => { if (!busy) close(); }}>
      <View style={{ gap: 10 }}>
        <Text style={{ color: colors.ink, fontSize: 16, lineHeight: 24 }}>Here is what changes:</Text>
        {effects.map(line => <View key={line} style={{ flexDirection: 'row', gap: 8 }}><Text accessible={false} aria-hidden style={{ color: colors.ink, fontSize: 16, lineHeight: 24 }}>•</Text><Text style={{ flex: 1, color: colors.ink, fontSize: 16, lineHeight: 24 }}>{line}</Text></View>)}
      </View>
      {failure ? <Text accessibilityRole="alert" accessibilityLiveRegion="polite" role="alert" style={{ color: colors.danger, fontSize: 15, lineHeight: 23 }}>{failure.message}</Text> : null}
      {!failure || failure.retry ? <Pressable accessibilityRole="button" accessibilityLabel={busy ? 'Leaving…' : failure ? `Try again to leave ${name}` : `Leave ${name}`} accessibilityState={{ disabled: busy, busy }} disabled={busy} onPress={() => void confirm()}
        style={({ pressed }) => ({ minHeight: 48, paddingHorizontal: 22, paddingVertical: 12, alignItems: 'center', justifyContent: 'center', borderRadius: 999, backgroundColor: colors.danger, opacity: busy ? 0.6 : pressed ? 0.85 : 1, ...(Platform.OS === 'web' ? { cursor: busy ? 'default' : 'pointer' } as object : {}) })}>
        <Text style={{ color: '#FFFFFF', fontSize: 15, lineHeight: 22, fontWeight: '700' }}>{busy ? 'Leaving…' : failure ? 'Try again' : `Leave ${name}`}</Text>
      </Pressable> : null}
      <MarketButton label={failure && !failure.retry ? 'Close' : 'Cancel'} variant="secondary" disabled={busy} onPress={close} />
    </AccessiblePanel> : null}
  </View>;
}
