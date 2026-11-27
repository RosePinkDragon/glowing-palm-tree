import { useEffect, useRef, useState, type ComponentRef } from 'react';
import { AccessibilityInfo, findNodeHandle, Modal, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { businesses, type BusinessSlug } from '@market/core';
import { MarketButton } from './components';
import { AccessiblePanel, capturePanelFocus, restorePanelFocus } from './AccessiblePanel';
import { clearLocalKeys, deleteAccountCopy, deleteAccountEntry, deletedNotice, deletionFailure, type DeletionFailure } from './account-deletion-model';
import { cartKey } from './cart-state';
import { attemptKey, sameIdentity } from './checkout-state';
import { leaveRequestKey } from './leave-model';
import { ownNameKey } from './recipient-model';
import { MarketIcon } from './MarketIcons';
import { useMarketFonts, useMarketTheme } from './theme';
import { preferenceKey } from './useNotificationPreferences';
import type { useMarket } from './useMarket';

type Market = ReturnType<typeof useMarket>;
const keepId = 'delete-account-keep';

/** Everything this phone saved for the account, in both restaurants' namespaces (guarded storage: a blocked key never stops the sign-out). */
const localKeys = (userId: string) => [...(Object.keys(businesses) as BusinessSlug[]).flatMap(slug => [cartKey(slug), attemptKey(slug), preferenceKey(slug, 'customer', userId), leaveRequestKey(slug, userId)]), ownNameKey(userId)];

/**
 * "Delete my account" (#51): a quiet row on Edit profile that opens a warning sheet. The server closes the account at once (one call, safe to repeat),
 * then this phone is cleared and signed out, and the parent shows the final "being deleted" state, which has to outlive this screen.
 * Keep my account is the focused, safe choice; the destructive button is a second, separate step, never a checkbox.
 */
export function DeleteAccount({ market, signOut, onDeleted, go, login }: { market: Market; signOut: () => Promise<void>; onDeleted: (result: { signedOut: boolean }) => void; go: (path: string) => void; login: (next: string) => void }) {
  const { colors, name, businessId } = useMarketTheme(); const fonts = useMarketFonts();
  const other = Object.values(businesses).map(business => business.name).find(value => value !== name) ?? name;
  const copy = deleteAccountCopy(name, other);
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [failure, setFailure] = useState<DeletionFailure | null>(null);
  const sending = useRef(false), trigger = useRef<HTMLElement | null>(null);
  const userId = market.session?.user.id ?? null;
  const close = () => { if (busy) return; setOpen(false); setFailure(null); restorePanelFocus(trigger.current); };
  /** The server account is already pending: this phone is cleaned and the notice shown whatever else changed. Only a still-current session is signed out. */
  const finish = async (id: string, started: typeof market.identity.current) => {
    // Sign out first: it also resets the cart draft, which writes an empty record for this account; the clean-up then removes that too.
    let signedOut = true;
    if (sameIdentity(started, market.identity.current)) { try { await signOut(); } catch { signedOut = false; } }
    await clearLocalKeys(AsyncStorage, localKeys(id));
    setOpen(false); setFailure(null);
    onDeleted({ signedOut });
  };
  const confirm = async () => {
    if (sending.current || !userId || market.services.mode !== 'backend') return;
    sending.current = true; setBusy(true); setFailure(null);
    const started = market.identity.current;
    let accepted = false;
    try {
      try { await market.services.requestAccountDeletion(); accepted = true; }
      catch (e) {
        const problem = deletionFailure(e);
        // Already being deleted is the outcome the person asked for: carry on to the same clean-up.
        if (problem.kind === 'already-pending') accepted = true;
        else if (sameIdentity(started, market.identity.current)) setFailure(problem);
      }
      if (accepted) await finish(userId, started);
    } finally { sending.current = false; setBusy(false); }
  };
  // The confirm button that had focus is gone when the sheet switches to a blocked view: focus its primary button.
  const blockedKind = failure && !failure.retry ? failure.kind : null;
  useEffect(() => { if (blockedKind && Platform.OS === 'web') { const id = setTimeout(() => document.getElementById(keepId)?.focus(), 0); return () => clearTimeout(id); } }, [blockedKind]);
  const blocked = failure && !failure.retry ? failure : null, retryable = failure?.retry ? failure : null;
  const danger = { color: colors.danger, fontSize: 15, lineHeight: 22, ...(fonts.bodySemiBold ? { fontFamily: fonts.bodySemiBold } : { fontWeight: '700' as const }) };
  const destructive = (label: string, onPress: () => void) => <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: busy, busy }} disabled={busy} onPress={onPress}
    style={({ pressed }) => ({ minHeight: 48, paddingHorizontal: 22, paddingVertical: 12, alignItems: 'center', justifyContent: 'center', borderRadius: 14, backgroundColor: colors.danger, opacity: busy ? 0.6 : pressed ? 0.85 : 1, ...(Platform.OS === 'web' ? { cursor: busy ? 'default' : 'pointer' } as object : {}) })}>
    <Text style={{ color: '#FFFFFF', fontSize: 15, lineHeight: 22, fontWeight: '700' }}>{label}</Text>
  </Pressable>;
  return <View style={{ paddingTop: 6, borderTopWidth: 1, borderTopColor: colors.border }} testID={`delete-account-${businessId}`}>
    <Pressable accessibilityRole="button" accessibilityLabel={`${deleteAccountEntry.label}, ${deleteAccountEntry.hint.charAt(0).toLowerCase()}${deleteAccountEntry.hint.slice(1)}`} onPress={() => { trigger.current = capturePanelFocus(); setFailure(null); setOpen(true); }}
      style={{ minHeight: 56, flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8 }}>
      <MarketIcon name="trash" color={colors.danger} size={19} />
      <View style={{ flex: 1 }}><Text style={danger}>{deleteAccountEntry.label}</Text><Text style={{ color: colors.muted, fontSize: 13, lineHeight: 19 }}>{deleteAccountEntry.hint}</Text></View>
    </Pressable>
    {open ? <AccessiblePanel sheet title={blocked ? blocked.title : copy.title} initialFocusId={keepId} closeDisabled={busy} onClose={close}>
      {blocked ? <>
        <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={{ color: colors.ink, fontSize: 16, lineHeight: 24 }}>{blocked.message}</Text>
        {blocked.kind === 'active-order' ? <MarketButton nativeID={keepId} label="View your orders" onPress={() => { setOpen(false); setFailure(null); go('/orders'); }} /> : null}
        {blocked.kind === 'sign-in' ? <MarketButton nativeID={keepId} label="Sign in" onPress={() => { setOpen(false); setFailure(null); void market.services.auth.signOut().catch(() => {}).finally(() => login('/profile')); }} /> : null}
        <MarketButton nativeID={blocked.kind === 'only-owner' ? keepId : undefined} label="OK" variant="secondary" onPress={close} />
      </> : <>
        <Text style={{ color: colors.ink, fontSize: 16, lineHeight: 24 }}>{copy.intro}</Text>
        {copy.points.map(point => <View key={point.heading} style={{ gap: 2 }}>
          <Text accessibilityRole="header" aria-level={2} style={{ color: colors.ink, fontSize: 15, lineHeight: 22, fontWeight: '700' }}>{point.heading}</Text>
          <Text style={{ color: colors.muted, fontSize: 15, lineHeight: 23 }}>{point.text}</Text>
        </View>)}
        {retryable ? <Text accessibilityRole="alert" accessibilityLiveRegion="polite" role="alert" style={{ color: colors.danger, fontSize: 15, lineHeight: 23 }}>{`${retryable.title}. ${retryable.message}`}</Text> : null}
        {destructive(busy ? copy.busy : retryable ? 'Try again' : copy.confirm, () => void confirm())}
        <MarketButton nativeID={keepId} label={copy.keep} variant="secondary" disabled={busy} onPress={close} />
      </>}
    </AccessiblePanel> : null}
  </View>;
}

/** The last screen: shown by the parent (the Edit profile screen is gone once the phone is signed out). It never says the deletion is finished. */
export function AccountDeletedNotice({ signedOut, onClose }: { signedOut: boolean; onClose: () => void }) {
  const { colors, businessId } = useMarketTheme(); const fonts = useMarketFonts();
  const ammu = businessId === 'ammu-sammu';
  const title = useRef<ComponentRef<typeof Text>>(null);
  const focusTitle = () => { if (Platform.OS === 'web') (title.current as unknown as HTMLElement | null)?.focus(); else { const handle = findNodeHandle(title.current); if (handle != null) AccessibilityInfo.setAccessibilityFocus(handle); } };
  return <Modal visible animationType="none" onRequestClose={onClose} onShow={focusTitle}>
    <SafeAreaProvider><SafeAreaView accessibilityViewIsModal style={{ flex: 1, backgroundColor: colors.background }}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ flexGrow: 1, padding: 24, gap: 16, width: '100%', maxWidth: 520, alignSelf: 'center', justifyContent: 'center' }}>
        <View accessible={false} aria-hidden style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: ammu ? colors.tint : colors.band, alignItems: 'center', justifyContent: 'center' }}><Text style={{ color: ammu ? colors.positive : colors.bandAccent, fontSize: 22 }}>✓</Text></View>
        <Text ref={title} accessibilityRole="header" aria-level={1} {...({ tabIndex: -1 } as object)} style={{ color: colors.ink, fontSize: 28, lineHeight: 36, ...(fonts.heading ? { fontFamily: fonts.heading } : { fontWeight: '700' as const }) }}>{deletedNotice.title}</Text>
        <Text style={{ color: colors.muted, fontSize: 16, lineHeight: 24 }}>{deletedNotice.message}</Text>
        {!signedOut ? <Text accessibilityRole="alert" style={{ color: colors.danger, fontSize: 15, lineHeight: 23 }}>{deletedNotice.signOutFailed}</Text> : null}
        <MarketButton label={deletedNotice.close} onPress={onClose} />
      </ScrollView>
    </SafeAreaView></SafeAreaProvider>
  </Modal>;
}
