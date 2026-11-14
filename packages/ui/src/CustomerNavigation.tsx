import { createContext, useContext, useEffect, useRef, useState, type ComponentRef, type ReactNode, type RefObject } from 'react';
import { AccessibilityInfo, findNodeHandle, Animated, Modal, Platform, Pressable, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import { CommonActions, NavigationContainer, StackActions, useNavigationContainerRef, type RouteProp } from '@react-navigation/native';
import { createNativeStackNavigator, type NativeStackNavigationProp } from '@react-navigation/native-stack';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import * as Linking from 'expo-linking';
import { MarketButton, MarketStatus, MarketText } from './components';
import { capturePanelFocus, restorePanelFocus } from './AccessiblePanel';
import { useMarketTheme } from './theme';
import type { useMarket } from './useMarket';

export type CustomerScreen = 'Menu' | 'Cart' | 'Orders' | 'Order' | 'Account' | 'Login';
type Routes = { Menu: undefined; Cart: undefined; Orders: undefined; Order: { id: string }; Account: undefined; Login: { next?: string } | undefined; NotFound: undefined };
type Market = ReturnType<typeof useMarket>;
type Controls = { go: (path: string) => void; login: (next: string) => void };
const Stack = createNativeStackNavigator<Routes>();
const Content = createContext<{ market: Market; render: (page: CustomerScreen, id?: string) => ReactNode } | null>(null);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
function destination(path: string) {
  if (path === '/cart') return { name: 'Cart', params: undefined };
  if (path === '/orders') return { name: 'Orders', params: undefined };
  if (path === '/account') return { name: 'Account', params: undefined };
  const id = path.startsWith('/orders/') ? path.slice(8) : '';
  if (uuid.test(id)) return { name: 'Order', params: { id } };
  return { name: 'Menu', params: undefined };
}
function CustomerRoute({ route, navigation }: { route: RouteProp<Routes>; navigation: NativeStackNavigationProp<Routes> }) {
  const { market, render } = useContext(Content)!;
  const params = route.params as { id?: string; next?: string } | undefined;
  const protectedScreen = route.name === 'Orders' || route.name === 'Order' || route.name === 'Account';
  const target = route.name === 'Order' ? `/orders/${params?.id ?? ''}` : route.name === 'Orders' ? '/orders' : '/account';
  useEffect(() => {
    if (!market.authReady) return;
    if (protectedScreen && !market.session) navigation.dispatch(StackActions.replace('Login', { next: target }));
    if (route.name === 'Login' && market.session && !market.recovery) { const next = destination(params?.next ?? '/account'); navigation.dispatch(StackActions.popTo(next.name, next.params)); }
  }, [market.authReady, market.session?.user.id, market.recovery, protectedScreen, route.name, target, params?.next, navigation]);
  if ((protectedScreen && (!market.authReady || !market.session)) || (route.name === 'Login' && !market.authReady)) return <MarketStatus kind="loading" title="Checking your account" />;
  if (route.name === 'NotFound') return <MarketStatus kind="empty" title="Page not found" action={<MarketButton label="Browse menu" onPress={() => navigation.navigate('Menu')} />} />;
  return render(route.name as CustomerScreen, params?.id);
}

export function CustomerNavigation({ market, render, controls, cartCount }: { market: Market; render: (page: CustomerScreen, id?: string) => ReactNode; controls: RefObject<Controls | null>; cartCount: number }) {
  const navigation = useNavigationContainerRef<Routes>();
  const { colors, name } = useMarketTheme();
  const [drawer, setDrawer] = useState(false);
  const opener = useRef<HTMLElement | null>(null);
  const closeDrawer = () => { setDrawer(false); restorePanelFocus(opener.current); };
  controls.current = {
    go(path) { if (navigation.isReady()) { const next = destination(path); const existing = navigation.getRootState()?.routes.some(route => route.name === next.name && (next.name !== 'Order' || (route.params as { id?: string } | undefined)?.id === next.params?.id)); navigation.dispatch(existing ? StackActions.popTo(next.name, next.params) : CommonActions.navigate(next.name, next.params)); } },
    login(next) { if (navigation.isReady()) navigation.navigate('Login', { next }); }
  };
  useEffect(() => {
    if (market.recovery && navigation.isReady()) navigation.navigate('Login', { next: '/account' });
  }, [market.recovery, navigation]);
  const linking = {
    prefixes: [Linking.createURL('/')],
    config: { initialRouteName: 'Menu' as const, screens: { Menu: '', Cart: 'cart', Orders: 'orders', Order: 'orders/:id', Account: 'account', Login: 'login', NotFound: '*' } }
  };
  return <SafeAreaProvider><Content.Provider value={{ market, render }}>
    <NavigationContainer ref={navigation} linking={linking} fallback={<MarketStatus kind="loading" title="Opening the app" />} theme={{ dark: false, colors: { primary: colors.primary, background: colors.background, card: colors.surface, text: colors.ink, border: colors.border, notification: colors.primary }, fonts: { regular: { fontFamily: 'System', fontWeight: '400' }, medium: { fontFamily: 'System', fontWeight: '500' }, bold: { fontFamily: 'System', fontWeight: '700' }, heavy: { fontFamily: 'System', fontWeight: '800' } } }}>
      <Stack.Navigator screenOptions={({ route }) => ({ title: route.name === 'Menu' ? name : route.name === 'Order' ? 'Order status' : route.name === 'Login' ? 'Sign in' : route.name === 'NotFound' ? 'Page not found' : route.name === 'Cart' ? 'Your cart' : route.name === 'Orders' ? 'Your orders' : 'Your account', headerBackTitle: 'Back', contentStyle: { backgroundColor: colors.background }, headerRight: () => <MarketButton label="Account" variant="secondary" onPress={() => { opener.current = capturePanelFocus(); setDrawer(true); }} /> })}>
        {(['Menu', 'Cart', 'Orders', 'Order', 'Account', 'Login', 'NotFound'] as const).map(screen => <Stack.Screen key={screen} name={screen} component={CustomerRoute} />)}
      </Stack.Navigator>
    </NavigationContainer>
    {cartCount ? <View style={{ padding: 12, backgroundColor: colors.surface, borderTopWidth: 1, borderColor: colors.border }}><MarketButton label={`Cart (${cartCount}) · View cart`} onPress={() => controls.current?.go('/cart')} /></View> : null}
    <AccountDrawer open={drawer} close={closeDrawer} market={market} onNavigate={path => { closeDrawer(); controls.current?.go(path); }} onLogin={() => { closeDrawer(); controls.current?.login('/account'); }} />
  </Content.Provider></SafeAreaProvider>;
}

function AccountDrawer({ open, close, market, onNavigate, onLogin }: { open: boolean; close: () => void; market: Market; onNavigate: (path: string) => void; onLogin: () => void }) {
  const { colors } = useMarketTheme(); const { width } = useWindowDimensions();
  const translate = useRef(new Animated.Value(width)).current;
  const panel = useRef<ComponentRef<typeof ScrollView>>(null); const title = useRef<ComponentRef<typeof Text>>(null);
  useEffect(() => {
    if (!open || Platform.OS !== 'web') return;
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); close(); }
      if (event.key !== 'Tab') return;
      const element = panel.current?.getScrollableNode() as unknown as HTMLElement | null;
      const elements = Array.from(element?.querySelectorAll<HTMLElement>('button,[role="button"],[tabindex="0"],input,a[href]') ?? []).filter(node => !node.hasAttribute('disabled') && node.getAttribute('aria-disabled') !== 'true');
      const first = elements[0], last = elements.at(-1);
      if (event.shiftKey && (document.activeElement === first || document.activeElement === title.current as unknown as HTMLElement)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !element?.contains(document.activeElement))) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', keydown); return () => document.removeEventListener('keydown', keydown);
  }, [open, close]);
  return <Modal visible={open} transparent animationType="none" onRequestClose={close} onShow={() => { translate.setValue(width); Animated.timing(translate, { toValue: 0, duration: 220, useNativeDriver: true }).start(); if (Platform.OS === 'web') (title.current as unknown as HTMLElement | null)?.focus(); else { const handle = findNodeHandle(title.current); if (handle != null) AccessibilityInfo.setAccessibilityFocus(handle); } }}>
    <View style={{ flex: 1, flexDirection: 'row', justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.5)' }}>
      <Pressable accessibilityLabel="Close account drawer" accessibilityRole="button" onPress={close} style={{ position: 'absolute', top: 0, bottom: 0, right: 0, left: 0 }} />
      <Animated.View style={{ width: Math.min(width - 32, 400), height: '100%', backgroundColor: colors.surface, transform: [{ translateX: translate }] }}>
        <ScrollView ref={panel} accessibilityViewIsModal keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 24, paddingTop: 40, gap: 20 }}>
          <Text ref={title} accessibilityRole="header" {...({ tabIndex: -1 } as object)} style={{ color: colors.ink, fontSize: 24, fontWeight: '700' }}>Your account</Text>
          <MarketButton label="Close" variant="secondary" onPress={close} />
          {market.authReady ? market.session ? <><MarketText>{market.session.user.email ?? 'Signed in'}</MarketText><MarketButton label="Account settings" variant="secondary" onPress={() => onNavigate('/account')} /><MarketButton label="Your orders" variant="secondary" onPress={() => onNavigate('/orders')} /></> : <><MarketText>Sign in to see your account and orders.</MarketText><MarketButton label="Sign in" onPress={onLogin} /></> : <MarketStatus kind="loading" title="Checking your account" />}
          <MarketButton label="Browse menu" variant="secondary" onPress={() => onNavigate('/')} />
        </ScrollView>
      </Animated.View>
    </View>
  </Modal>;
}
