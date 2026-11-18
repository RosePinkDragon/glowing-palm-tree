import { useEffect, useRef, useState, type ComponentRef } from 'react';
import { AccessibilityInfo, Animated, findNodeHandle, Modal, Platform, Pressable, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import type { useMarket } from './useMarket';
import { MarketButton, MarketText } from './components';
import { CustomerHistory, type ReorderAction } from './CustomerOrders';
import { unreadLabel } from './notification-inbox';
import { useMarketTheme } from './theme';

type Market = ReturnType<typeof useMarket>;
export function AccountDrawer({ open, close, market, go, signOut, onReorder, covered }: { open: boolean; close: (restore?: boolean) => void; market: Market; go: (path: string) => void; signOut: () => Promise<void>; onReorder: ReorderAction; covered: boolean }) {
  const { colors, name, businessId } = useMarketTheme(); const { width } = useWindowDimensions();
  const translate = useRef(new Animated.Value(width)).current;
  const panel = useRef<ComponentRef<typeof ScrollView>>(null), title = useRef<ComponentRef<typeof Text>>(null);
  const [options, setOptions] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const user = market.session?.user;
  const optionTrigger = useRef<ComponentRef<typeof Pressable>>(null);
  const fullName = typeof user?.user_metadata.full_name === 'string' ? user.user_metadata.full_name.trim().slice(0, 120) : '';
  const navigate = (path: string) => { setOptions(false); close(false); go(path); };
  useEffect(() => { if (!open) { setOptions(false); setError(''); } }, [open]);
  const refreshCount = market.inbox.refreshCount;
  useEffect(() => { if (open && user) void refreshCount(); }, [open, user?.id, refreshCount]);
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
        <ScrollView ref={panel} accessibilityViewIsModal={!covered} accessibilityElementsHidden={covered} importantForAccessibility={covered ? 'no-hide-descendants' : 'auto'} keyboardShouldPersistTaps="handled" scrollEventThrottle={150} onScroll={({ nativeEvent: { contentOffset, layoutMeasurement, contentSize } }) => { if (layoutMeasurement.height + contentOffset.y >= contentSize.height - 180 && !market.olderOrdersError) void market.loadOlderOrders(); }} contentContainerStyle={{ paddingBottom: 30, gap: 24 }}>
          <View style={{ padding: 24, gap: 18, backgroundColor: colors.primary }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
              <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={() => close()} style={{ minHeight: 48, minWidth: 48, justifyContent: 'center' }}><Text style={{ color: colors.onPrimary, fontSize: 26 }}>×</Text></Pressable>
              <Pressable accessibilityRole="button" accessibilityLabel="Help" onPress={() => navigate('/help')} style={{ minHeight: 48, paddingHorizontal: 16, justifyContent: 'center', marginLeft: 'auto' }}><Text style={{ color: colors.onPrimary, fontWeight: '700' }}>Help</Text></Pressable>
              <Pressable ref={optionTrigger} accessibilityRole="button" accessibilityLabel="Account options" accessibilityState={{ expanded: options }} onPress={() => setOptions(value => !value)} style={{ minHeight: 48, minWidth: 48, alignItems: 'center', justifyContent: 'center' }}><Text style={{ color: colors.onPrimary, fontSize: 26 }}>⋮</Text></Pressable>
            </View>
            <Text ref={title} accessibilityRole="header" {...({ tabIndex: -1 } as object)} style={{ color: colors.onPrimary, fontSize: 26, fontWeight: '700' }}>{fullName || 'Your account'}</Text>
            <Text style={{ color: colors.onPrimary, fontSize: 16 }}>{user?.phone || 'Phone not added'}</Text>
            {options ? <View style={{ padding: 12, borderRadius: 14, backgroundColor: colors.surface, gap: 8 }}><MarketButton label="Edit profile" variant="secondary" onPress={() => navigate('/profile')} /><MarketButton label="Log out" variant="secondary" disabled={busy} onPress={() => void logout()} /></View> : null}
          </View>
          <View style={{ paddingHorizontal: 20, gap: 24 }}>
            <View style={{ flexDirection: businessId === 'ammu-sammu' ? 'row' : 'column', flexWrap: 'wrap', gap: 8 }}>
              {[['Saved addresses', '/addresses'], ['Notifications', '/notifications'], ['Help & support', '/help']].map(([label, path]) => <Pressable key={path} accessibilityRole="button" accessibilityLabel={path === '/notifications' ? `${label}${unreadLabel(market.inbox.unread)}` : label} onPress={() => navigate(path)} style={{ minHeight: 64, flexGrow: businessId === 'ammu-sammu' ? 1 : 0, flexBasis: businessId === 'ammu-sammu' ? 122 : undefined, minWidth: businessId === 'ammu-sammu' ? 122 : undefined, width: businessId === 'kokani-dine-inn' ? '100%' : undefined, alignSelf: 'stretch', justifyContent: 'center', padding: 10, borderWidth: 1, borderRadius: 14, borderColor: colors.border, backgroundColor: colors.surface }}><View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><Text style={{ color: colors.primary, fontSize: 15, fontWeight: '700' }}>{label}</Text>{path === '/notifications' && market.inbox.unread ? <View accessible={false} testID="unread-badge" style={{ minWidth: 22, height: 22, paddingHorizontal: 6, borderRadius: 11, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primary }}><Text style={{ color: colors.onPrimary, fontSize: 12, lineHeight: 16, fontWeight: '700' }}>{market.inbox.unread > 99 ? '99+' : market.inbox.unread}</Text></View> : null}</View></Pressable>)}
            </View>
            <MarketButton label="Account settings" variant="secondary" onPress={() => navigate('/account')} />
            <MarketButton label="Your orders" variant="secondary" onPress={() => navigate('/orders')} />
            {error ? <Text accessibilityRole="alert" style={{ color: colors.danger }}>{error}</Text> : null}
            <CustomerHistory market={market} go={navigate} onReorder={onReorder} />
            <MarketButton label={busy ? 'Logging out…' : 'Log out'} variant="secondary" disabled={busy} onPress={() => void logout()} />
            <MarketText variant="muted">{name}</MarketText>
            <MarketButton label="Browse menu" variant="secondary" onPress={() => navigate('/')} />
          </View>
        </ScrollView>
      </Animated.View>
    </View>
  </Modal>;
}
