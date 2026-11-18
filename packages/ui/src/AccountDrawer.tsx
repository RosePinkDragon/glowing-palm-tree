import { useEffect, useRef, useState, type ComponentRef } from 'react';
import { AccessibilityInfo, Animated, findNodeHandle, Modal, Platform, Pressable, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import type { useMarket } from './useMarket';
import { MarketButton, MarketText } from './components';
import { CustomerHistory, type ReorderAction } from './CustomerOrders';
import { useMarketFonts, useMarketTheme } from './theme';
import { MarketIcon, type MarketIconName } from './MarketIcons';
import { BrandLogo } from './OwnerShell';

type Market = ReturnType<typeof useMarket>;
export function AccountDrawer({ open, close, market, go, signOut, onReorder, covered }: { open: boolean; close: (restore?: boolean) => void; market: Market; go: (path: string) => void; signOut: () => Promise<void>; onReorder: ReorderAction; covered: boolean }) {
  const { colors, name, businessId } = useMarketTheme(); const fonts = useMarketFonts(); const { width } = useWindowDimensions();
  const ammu = businessId === 'ammu-sammu';
  const translate = useRef(new Animated.Value(width)).current;
  const panel = useRef<ComponentRef<typeof ScrollView>>(null), title = useRef<ComponentRef<typeof Text>>(null);
  const [options, setOptions] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const user = market.session?.user;
  const optionTrigger = useRef<ComponentRef<typeof Pressable>>(null);
  const fullName = typeof user?.user_metadata.full_name === 'string' ? user.user_metadata.full_name.trim().slice(0, 120) : '';
  const initials = fullName.split(/\s+/).filter(Boolean).slice(0, 2).map(part => Array.from(part)[0]).join('').toUpperCase();
  const navigate = (path: string) => { setOptions(false); close(false); go(path); };
  useEffect(() => { if (!open) { setOptions(false); setError(''); } }, [open]);
  useEffect(() => {
    if (!open || covered || Platform.OS !== 'web') return;
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const element = panel.current?.getScrollableNode() as unknown as HTMLElement | null;
      const elements = Array.from(element?.querySelectorAll<HTMLElement>('button,[role="button"],[tabindex="0"],input,a[href]') ?? []).filter(node => !node.hasAttribute('disabled') && node.getAttribute('aria-disabled') !== 'true' && node.getClientRects().length > 0);
      const first = elements[0], last = elements.at(-1);
      if (event.shiftKey && (document.activeElement === first || document.activeElement === title.current as unknown as HTMLElement)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !element?.contains(document.activeElement))) { event.preventDefault(); first?.focus(); }
    };
    const back = () => close(false);
    document.addEventListener('keydown', keydown); window.addEventListener('popstate', back);
    return () => { document.removeEventListener('keydown', keydown); window.removeEventListener('popstate', back); };
  }, [open, options, close, covered]);
  const dismiss = () => {
    if (!options) { close(); return; }
    setOptions(false);
    if (Platform.OS === 'web') (optionTrigger.current as unknown as HTMLElement | null)?.focus();
    else { const handle = findNodeHandle(optionTrigger.current); if (handle != null) AccessibilityInfo.setAccessibilityFocus(handle); }
  };
  const logout = async () => {
    if (busy) return; setBusy(true); setOptions(false); setError('');
    try { await signOut(); close(false); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not log out. Please try again.'); }
    finally { setBusy(false); }
  };
  return <Modal visible={open && !!user} transparent animationType="none" onRequestClose={dismiss} onShow={() => {
    translate.setValue(width); Animated.timing(translate, { toValue: 0, duration: 220, useNativeDriver: true }).start();
    if (Platform.OS === 'web') (title.current as unknown as HTMLElement | null)?.focus();
    else { const handle = findNodeHandle(title.current); if (handle != null) AccessibilityInfo.setAccessibilityFocus(handle); }
  }}>
    <View style={{ flex: 1, flexDirection: 'row', justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.5)' }}>
      <Pressable accessible={false} importantForAccessibility="no" onPress={() => close()} style={{ position: 'absolute', inset: 0 }} />
      <Animated.View style={{ width: Math.min(width - 20, 430), height: '100%', backgroundColor: colors.background, transform: [{ translateX: translate }] }}>
        <ScrollView ref={panel} accessibilityViewIsModal={!covered} accessibilityElementsHidden={covered} importantForAccessibility={covered ? 'no-hide-descendants' : 'auto'} keyboardShouldPersistTaps="handled" scrollEventThrottle={150} onScroll={({ nativeEvent: { contentOffset, layoutMeasurement, contentSize } }) => { if (layoutMeasurement.height + contentOffset.y >= contentSize.height - 180 && !market.olderOrdersError) void market.loadOlderOrders(); }} contentContainerStyle={{ paddingBottom: 30, gap: 18 }}>
          <View style={{ paddingHorizontal: 20, paddingBottom: 20, gap: 8, backgroundColor: ammu ? colors.primary : colors.band }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
              <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={() => close()} style={{ minHeight: 48, minWidth: 48, justifyContent: 'center' }}><Text style={{ color: colors.onPrimary, fontSize: 26 }}>×</Text></Pressable>
              <Pressable accessibilityRole="button" accessibilityLabel="Help" onPress={() => navigate('/help')} style={{ minHeight: 48, paddingHorizontal: 16, justifyContent: 'center', marginLeft: 'auto' }}><Text style={{ color: colors.onPrimary, fontWeight: '700' }}>Help</Text></Pressable>
              <Pressable ref={optionTrigger} accessibilityRole="button" accessibilityLabel="Account options" accessibilityState={{ expanded: options }} onPress={() => setOptions(value => !value)} style={{ minHeight: 48, minWidth: 48, alignItems: 'center', justifyContent: 'center' }}><Text style={{ color: colors.onPrimary, fontSize: 26 }}>⋮</Text></Pressable>
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
              <View accessible={false} style={{ width: 60, height: 60, borderRadius: 30, borderWidth: 1, borderColor: colors.onPrimary, alignItems: 'center', justifyContent: 'center' }}><Text style={{ color: colors.onPrimary, fontSize: 22 }}>{initials || '◯'}</Text></View>
              <View style={{ flex: 1, gap: 4 }}><Text ref={title} accessibilityRole="header" {...({ tabIndex: -1 } as object)} style={{ color: colors.onPrimary, fontSize: 23, ...(fonts.heading ? { fontFamily: fonts.heading } : { fontWeight: '700' }) }}>{fullName || 'Your account'}</Text>
              <Text style={{ color: colors.onPrimary, fontSize: 14 }}>{user?.phone || 'Phone not added'}</Text></View>
            </View>
            {options ? <View style={{ padding: 12, borderRadius: 14, backgroundColor: colors.surface, gap: 8 }}><MarketButton label="Edit profile" variant="secondary" onPress={() => navigate('/profile')} /><MarketButton label="Log out" variant="secondary" disabled={busy} onPress={() => void logout()} /></View> : null}
          </View>
          <View style={{ paddingHorizontal: 16, gap: 16 }}>
            <View style={ammu ? { flexDirection: 'row', gap: 8 } : { borderWidth: 1, borderColor: colors.border, borderRadius: 14, backgroundColor: colors.surface, paddingHorizontal: 12 }}>
              {([['Saved addresses', '/addresses', 'pin'], ['Notifications', '/notifications', 'bell'], ['Help & support', '/help', 'help']] as [string, string, MarketIconName][]).map(([label, path, icon], index) => <Pressable key={path} accessibilityRole="button" onPress={() => navigate(path)} style={ammu ? { flex: 1, minWidth: 0, minHeight: 86, padding: 10, gap: 8, borderWidth: 1, borderRadius: 14, borderColor: colors.border, backgroundColor: colors.surface } : { minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: 12, borderTopWidth: index ? 1 : 0, borderColor: colors.border }}><MarketIcon name={icon} color={colors.primary} size={19} /><Text style={{ color: colors.ink, fontSize: 14, flexShrink: 1, ...(fonts.bodySemiBold ? { fontFamily: fonts.bodySemiBold } : { fontWeight: '700' }) }}>{label}</Text>{!ammu ? <View style={{ marginLeft: 'auto' }}><MarketIcon name="chevronRight" color={colors.muted} /></View> : null}</Pressable>)}
            </View>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              {[['Account settings', '/account'], ['Your orders', '/orders']].map(([label, path]) => <Pressable key={path} accessibilityRole="button" onPress={() => navigate(path)} style={{ minHeight: 44, flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6 }}><Text style={{ color: colors.primary, fontWeight: '700', textAlign: 'center' }}>{label}</Text></Pressable>)}
            </View>
            {error ? <Text accessibilityRole="alert" style={{ color: colors.danger }}>{error}</Text> : null}
            <CustomerHistory market={market} go={navigate} onReorder={onReorder} drawer />
            <MarketButton label={busy ? 'Logging out…' : 'Log out'} variant="secondary" disabled={busy} onPress={() => void logout()} />
            <MarketButton label="Browse menu" variant="secondary" onPress={() => navigate('/')} />
            <View style={{ alignItems: 'center', gap: 8, paddingTop: 8 }}><BrandLogo height={52} /><MarketText variant="muted">{name} app</MarketText></View>
          </View>
        </ScrollView>
      </Animated.View>
    </View>
  </Modal>;
}
