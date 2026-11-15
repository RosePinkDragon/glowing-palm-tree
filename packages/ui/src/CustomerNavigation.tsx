import { createContext, useContext, useEffect, useRef, useState, type ComponentRef, type ReactNode, type RefObject } from 'react';
import { AccessibilityInfo, findNodeHandle, Platform, Pressable, Text, View } from 'react-native';
import { CommonActions, NavigationContainer, StackActions, useIsFocused, useNavigationContainerRef, type RouteProp } from '@react-navigation/native';
import { createNativeStackNavigator, type NativeStackNavigationProp } from '@react-navigation/native-stack';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import * as Linking from 'expo-linking';
import { MarketButton, MarketStatus, MarketText } from './components';
import { capturePanelFocus, restorePanelFocus } from './AccessiblePanel';
import { AccountDrawer } from './AccountDrawer';
import { useMarketTheme } from './theme';
import type { useMarket } from './useMarket';
import type { ReorderAction } from './CustomerOrders';

export type CustomerScreen = 'Menu' | 'Cart' | 'Orders' | 'Order' | 'Account' | 'Login' | 'Help' | 'Privacy' | 'Terms' | 'Profile' | 'Addresses' | 'Notifications';
type Routes = { Menu: undefined; Cart: undefined; Orders: undefined; Order: { id: string }; Account: undefined; Help: { id?: string } | undefined; Privacy: undefined; Terms: undefined; Profile: undefined; Addresses: undefined; Notifications: undefined; Login: { next?: string } | undefined; NotFound: undefined };
type Market = ReturnType<typeof useMarket>;
type Controls = { go: (path: string) => void; login: (next: string) => void };
const Stack = createNativeStackNavigator<Routes>();
const Content = createContext<{ market: Market; render: (page: CustomerScreen, id?: string) => ReactNode } | null>(null);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
function destination(path: string) {
  if (path === '/cart') return { name: 'Cart', params: undefined };
  if (path === '/orders') return { name: 'Orders', params: undefined };
  if (path === '/account') return { name: 'Account', params: undefined };
  if (path === '/help') return { name: 'Help', params: undefined };
  if (path.startsWith('/help?id=') && uuid.test(path.slice(9))) return { name: 'Help', params: { id: path.slice(9) } };
  if (path === '/privacy') return { name: 'Privacy', params: undefined };
  if (path === '/terms') return { name: 'Terms', params: undefined };
  if (path === '/login') return { name: 'Login', params: { next: '/help' } };
  if (path === '/profile') return { name: 'Profile', params: undefined };
  if (path === '/addresses') return { name: 'Addresses', params: undefined };
  if (path === '/notifications') return { name: 'Notifications', params: undefined };
  const id = path.startsWith('/orders/') ? path.slice(8) : '';
  if (uuid.test(id)) return { name: 'Order', params: { id } };
  return { name: 'Menu', params: undefined };
}
function CustomerRoute({ route, navigation }: { route: RouteProp<Routes>; navigation: NativeStackNavigationProp<Routes> }) {
  const { market, render } = useContext(Content)!;
  const focused = useIsFocused();
  const params = route.params as { id?: string; next?: string } | undefined;
  const protectedScreen = route.name === 'Orders' || route.name === 'Order' || route.name === 'Account' || route.name === 'Profile' || route.name === 'Addresses' || route.name === 'Notifications';
  const target = route.name === 'Order' ? `/orders/${params?.id ?? ''}` : route.name === 'Orders' ? '/orders' : route.name === 'Profile' ? '/profile' : route.name === 'Addresses' ? '/addresses' : route.name === 'Notifications' ? '/notifications' : '/account';
  useEffect(() => {
    if (!market.authReady || !focused) return;
    if (protectedScreen && !market.session) navigation.dispatch(StackActions.replace('Login', { next: target }));
    if (route.name === 'Login' && market.session && !market.recovery) { const next = destination(params?.next ?? '/account'); navigation.dispatch(StackActions.popTo(next.name, next.params)); }
  }, [focused, market.authReady, market.session?.user.id, market.recovery, protectedScreen, route.name, target, params?.next, navigation]);
  if ((protectedScreen && (!market.authReady || !market.session)) || (route.name === 'Login' && !market.authReady)) return <MarketStatus kind="loading" title="Checking your account" />;
  if (route.name === 'NotFound') return <MarketStatus kind="empty" title="Page not found" action={<MarketButton label="Browse menu" onPress={() => navigation.navigate('Menu')} />} />;
  return render(route.name as CustomerScreen, params?.id);
}

function AccountControl({ onPress }: { onPress: (node: ComponentRef<typeof Pressable> | null) => void }) {
  const button = useRef<ComponentRef<typeof Pressable>>(null);
  const { colors } = useMarketTheme();
  return <Pressable ref={button} accessibilityRole="button" accessibilityLabel="Account" onPress={() => onPress(button.current)} style={{ minHeight: 48, paddingHorizontal: 18, justifyContent: 'center' }}><Text style={{ color: colors.primary, fontWeight: '700' }}>Account</Text></Pressable>;
}

export function CustomerNavigation({ market, render, controls, cartCount, signOut, onReorder, reorderOpen, orderingAllowed }: { market: Market; render: (page: CustomerScreen, id?: string) => ReactNode; controls: RefObject<Controls | null>; cartCount: number; signOut: () => Promise<void>; onReorder: ReorderAction; reorderOpen: boolean; orderingAllowed: boolean }) {
  const navigation = useNavigationContainerRef<Routes>();
  const { colors, name } = useMarketTheme();
  const nativeOpener = useRef<ComponentRef<typeof Pressable> | null>(null);
  const [drawer, setDrawer] = useState(false);
  const opener = useRef<HTMLElement | null>(null);
  const closeDrawer = (restore = true) => { setDrawer(false); if (!restore) return; if (Platform.OS === 'web') restorePanelFocus(opener.current); else setTimeout(() => { const handle = findNodeHandle(nativeOpener.current); if (handle != null) AccessibilityInfo.setAccessibilityFocus(handle); }, 0); };
  useEffect(() => { setDrawer(false); }, [market.identityVersion]);
  controls.current = {
    go(path) { setDrawer(false); if (navigation.isReady()) { const next = destination(path); const existing = navigation.getRootState()?.routes.some(route => route.name === next.name && (next.name !== 'Order' || (route.params as { id?: string } | undefined)?.id === (next.params as { id?: string } | undefined)?.id)); navigation.dispatch(existing ? StackActions.popTo(next.name, next.params) : CommonActions.navigate(next.name, next.params)); } },
    login(next) { if (navigation.isReady()) navigation.navigate('Login', { next }); }
  };
  useEffect(() => {
    if (market.recovery && navigation.isReady()) navigation.navigate('Login', { next: '/account' });
  }, [market.recovery, navigation]);
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    const onTap = (event: MessageEvent) => {
      const data = event.data as { type?: unknown; path?: unknown } | null;
      const source = event.source as ServiceWorker | null;
      if (data?.type !== 'market:notification-tap' || typeof data.path !== 'string' || !source?.scriptURL || !navigation.isReady()) return;
      let worker: URL;
      try { worker = new URL(source.scriptURL); } catch { return; }
      if (worker.origin !== window.location.origin || !worker.pathname.endsWith('/firebase-messaging-worker.js')) return;
      if (data.path !== '/' && !(data.path.startsWith('/orders/') && uuid.test(data.path.slice(8)))) return;
      controls.current?.go(data.path);
      event.ports[0]?.postMessage({ accepted: true });
    };
    navigator.serviceWorker.addEventListener('message', onTap);
    return () => navigator.serviceWorker.removeEventListener('message', onTap);
  }, [navigation, controls]);
  const linking = {
    prefixes: [Linking.createURL('/')],
    config: { initialRouteName: 'Menu' as const, screens: { Menu: '', Cart: 'cart', Orders: 'orders', Order: 'orders/:id', Account: 'account', Help: 'help', Privacy: 'privacy', Terms: 'terms', Profile: 'profile', Addresses: 'addresses', Notifications: 'notifications', Login: 'login', NotFound: '*' } }
  };
  return <SafeAreaProvider><Content.Provider value={{ market, render }}>
    <View style={{ flex: 1 }} accessibilityElementsHidden={drawer} importantForAccessibility={drawer ? 'no-hide-descendants' : 'auto'}><NavigationContainer onStateChange={() => setDrawer(false)} ref={navigation} linking={linking} fallback={<MarketStatus kind="loading" title="Opening the app" />} theme={{ dark: false, colors: { primary: colors.primary, background: colors.background, card: colors.surface, text: colors.ink, border: colors.border, notification: colors.primary }, fonts: { regular: { fontFamily: 'System', fontWeight: '400' }, medium: { fontFamily: 'System', fontWeight: '500' }, bold: { fontFamily: 'System', fontWeight: '700' }, heavy: { fontFamily: 'System', fontWeight: '800' } } }}>
      <Stack.Navigator screenOptions={({ route }) => ({ title: route.name === 'Menu' ? name : route.name === 'Order' ? 'Order status' : route.name === 'Login' ? 'Sign in' : route.name === 'NotFound' ? 'Page not found' : route.name === 'Cart' ? 'Your cart' : route.name === 'Orders' ? 'Your orders' : route.name === 'Help' ? 'Help & support' : route.name === 'Privacy' ? 'Privacy policy' : route.name === 'Terms' ? 'Terms' : route.name === 'Profile' ? 'Edit profile' : route.name === 'Addresses' ? 'Saved addresses' : route.name === 'Notifications' ? 'Notifications' : 'Your account', headerBackTitle: 'Back', contentStyle: { backgroundColor: colors.background }, headerRight: () => <AccountControl onPress={node => { if (!market.authReady) return; if (!market.session) { controls.current?.login('/account'); return; } nativeOpener.current = node; opener.current = capturePanelFocus(); setDrawer(true); }} /> })}>
        {(['Menu', 'Cart', 'Orders', 'Order', 'Account', 'Login', 'Help', 'Privacy', 'Terms', 'Profile', 'Addresses', 'Notifications', 'NotFound'] as const).map(screen => <Stack.Screen key={screen} name={screen} component={CustomerRoute} />)}
      </Stack.Navigator>
    </NavigationContainer>
    {cartCount && orderingAllowed ? <View style={{ padding: 12, backgroundColor: colors.surface, borderTopWidth: 1, borderColor: colors.border }}><MarketButton label={`Cart (${cartCount}) · View cart`} onPress={() => controls.current?.go('/cart')} /></View> : null}
    </View>
    <AccountDrawer open={drawer} close={closeDrawer} market={market} go={path => controls.current?.go(path)} signOut={signOut} onReorder={onReorder} covered={reorderOpen} />
  </Content.Provider></SafeAreaProvider>;
}
