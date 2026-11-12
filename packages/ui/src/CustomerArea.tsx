import { useEffect, useRef, useState } from 'react';
import { Pressable, Text, View, useWindowDimensions } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import { addCartItem, cartSubtotalPaise, formatINRFromPaise, removeCartItem, setCartItemQuantity, validateDeliveryDetails, validateLocationFix, type BusinessSlug, type CartLine, type DeliveryDetails, type LocationFix, type Order } from '@market/core';
import { MarketButton, MarketCard, MarketField, MarketNavigation, MarketStatus, MarketText } from './components';
import { useMarketTheme } from './theme';
import { AuthPanel } from './AuthPanel';
import { attemptKey, freezeAttempt, isDefiniteOrderRejection, sameIdentity, type CheckoutAttempt } from './checkout-state';
import { requestLocation } from './location';
import { messageOf, useMarket } from './useMarket';

type Page = 'Menu' | 'Cart' | 'Orders' | 'Account';
const money = formatINRFromPaise;
export function CustomerArea({ businessId }: { businessId: BusinessSlug }) {
  const market = useMarket(businessId); const { colors, name } = useMarketTheme(); const { width } = useWindowDimensions();
  const [page, setPage] = useState<Page>('Menu'); const [category, setCategory] = useState('All');
  const [cart, setCart] = useState<CartLine[]>([]); const [details, setDetails] = useState<DeliveryDetails>({ name: '', phone: '', addressLine: '' });
  const [location, setLocation] = useState<LocationFix | null>(null); const [eligible, setEligible] = useState(false);
  const [busy, setBusy] = useState(false); const [localError, setLocalError] = useState(''); const [receipt, setReceipt] = useState<Order | null>(null);
  const sending = useRef(false);
  useEffect(() => { setReceipt(null); setDetails({ name: '', phone: '', addressLine: '' }); setLocation(null); setEligible(false); setLocalError(''); }, [market.identityVersion]);
  useEffect(() => { if (market.recovery) setPage('Account'); }, [market.recovery]);
  const demo = market.services.mode === 'demo' || !!market.business?.isDemo;
  const locked = !!market.attempt || !market.attemptReady || !!market.storageError;
  const categories = ['All', ...new Set(market.menu.map(item => item.category))];
  const changeCart = (fn: () => CartLine[]) => { try { setCart(fn()); setLocalError(''); } catch (e) { setLocalError(messageOf(e)); } };
  const locate = async () => {
    if (!market.session) { setPage('Account'); setLocalError('Sign in before checking your delivery location. Your cart will stay here.'); return; }
    const started = market.identity.current; setBusy(true); setLocalError(''); setEligible(false);
    try { const fix = await requestLocation(); const ok = await market.services.checkDeliveryEligibility(fix); if (!sameIdentity(started, market.identity.current)) return; setLocation(fix); setEligible(ok); if (!ok) setLocalError('This location is outside the current delivery area. You can check another location.'); }
    catch (e) { if (sameIdentity(started, market.identity.current)) { setLocation(null); setLocalError(messageOf(e)); } } finally { setBusy(false); }
  };
  const send = async (saved: CheckoutAttempt) => {
    if (sending.current || market.identity.current.userId !== saved.userId) return; const started = market.identity.current; sending.current = true; setBusy(true); setLocalError('');
    try {
      const order = await market.services.placeOrder(saved);
      if (!sameIdentity(started, market.identity.current)) return;
      setReceipt(order); setCart([]); setPage('Orders');
      try { await AsyncStorage.removeItem(attemptKey(businessId)); market.setAttempt(null); }
      catch { setLocalError('Your order was confirmed, but this device could not clear its saved attempt. Retry recovery before placing another order.'); }
      void market.refreshOrders();
    } catch (e) {
      if (!sameIdentity(started, market.identity.current)) return;
      if (isDefiniteOrderRejection(e)) {
        try { await AsyncStorage.removeItem(attemptKey(businessId)); market.setAttempt(null); if (sameIdentity(started, market.identity.current)) { setCart(saved.lines); setDetails(saved.delivery); setEligible(false); setLocalError(`${messageOf(e)} Please check your details and try again.`); } }
        catch { setLocalError('The order was declined, but its saved attempt could not be cleared. Retry recovery before placing another order.'); }
      } else setLocalError(`${messageOf(e)} The result may be uncertain. Retry this same order to recover its status.`);
    }
    finally { sending.current = false; setBusy(false); }
  };
  const checkout = async () => {
    if (sending.current || locked) return;
    if (!market.session) { setPage('Account'); setLocalError('Sign in before placing your order. Your cart will stay here.'); return; }
    sending.current = true; setBusy(true); setLocalError('');
    try {
      if (!market.business || demo || !market.business.orderingEnabled) throw new Error('Ordering is currently unavailable.');
      if (!cart.length) throw new Error('Add an item to your cart first.');
      if (cart.some(line => line.item.isDemo || !line.item.isAvailable)) throw new Error('Remove sample or unavailable items before ordering.');
      if (cartSubtotalPaise(cart) < market.business.minOrderPaise) throw new Error(`The minimum order is ${money(market.business.minOrderPaise)}.`);
      if (!location || !eligible) throw new Error('Check your delivery location first.');
      const saved = freezeAttempt({ businessId, userId: market.session.user.id, idempotencyKey: Crypto.randomUUID(), lines: cart, delivery: validateDeliveryDetails(details), location: validateLocationFix(location) });
      await AsyncStorage.setItem(attemptKey(businessId), JSON.stringify(saved));
      market.setAttempt(saved); sending.current = false;
      await send(saved);
    } catch (e) { setLocalError(messageOf(e)); } finally { sending.current = false; setBusy(false); }
  };
  const retry = () => { if (!market.attempt) return; if (market.session?.user.id !== market.attempt.userId) { setLocalError('Sign in with the account used for this order to recover it.'); setPage('Account'); return; } void send(market.attempt); };
  return <View style={{ paddingVertical: 28, gap: 24 }}>
    <View style={{ gap: 8 }}><MarketText variant="eyebrow">{name}</MarketText><MarketText variant="title">Good food starts here.</MarketText><MarketText variant="muted">Explore the menu and find something for your table.</MarketText></View>
    <MarketNavigation items={(['Menu', 'Cart', 'Orders', 'Account'] as Page[]).map(label => ({ label: label === 'Cart' && cart.length ? `Cart (${cart.reduce((n, line) => n + line.quantity, 0)})` : label, selected: page === label, onPress: () => { setPage(label); setLocalError(''); } }))} />
    {demo ? <MarketCard><MarketText variant="heading">Sample menu</MarketText><MarketText variant="muted">Items and prices shown as examples are for browsing only. Ordering is unavailable.</MarketText></MarketCard> : null}
    {market.notice ? <MarketText>{market.notice}</MarketText> : null}
    {market.error || localError || market.storageError ? <MarketCard><MarketText>{market.storageError || localError || market.error}</MarketText>{market.error ? <MarketButton label="Retry loading" variant="secondary" onPress={() => void market.load()} /> : null}</MarketCard> : null}
    {market.storageError ? <MarketText>Saved checkout state is unavailable. Ordering is paused to avoid creating a duplicate order.</MarketText> : null}
    {market.attempt ? <MarketCard><MarketText variant="heading">Order awaiting confirmation</MarketText><MarketText>Your previous order may have been received. Retry the same request to recover its result before changing the cart or placing another order.</MarketText><MarketButton label={busy ? 'Checking…' : 'Retry order recovery'} disabled={busy} onPress={retry} /></MarketCard> : null}
    {page === 'Menu' ? <View style={{ gap: 20 }}>
      <MarketText variant="heading">Our menu</MarketText>
      {market.loading ? <MarketStatus kind="loading" title="Loading menu" /> : <><View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>{categories.map(item => <Pressable key={item} accessibilityRole="button" aria-pressed={category === item} onPress={() => setCategory(item)} style={{ minHeight: 48, justifyContent: 'center', paddingHorizontal: 16, borderRadius: 14, backgroundColor: category === item ? colors.primary : colors.tint }}><Text style={{ color: category === item ? colors.onPrimary : colors.primary, fontWeight: '700' }}>{item}</Text></Pressable>)}</View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 16 }}>{market.menu.filter(item => category === 'All' || item.category === category).map(item => <View key={item.id} style={{ width: width >= 760 ? '48%' : '100%' }}><MarketCard><View accessible={false} style={{ height: 90, backgroundColor: colors.tint, borderRadius: 14, alignItems: 'center', justifyContent: 'center' }}><Text style={{ fontSize: 32, color: colors.primary, fontWeight: '700' }}>{item.name.charAt(0)}</Text></View><MarketText variant="eyebrow">{item.category}{item.isDemo ? ' · Example' : ''}</MarketText><MarketText variant="heading">{item.name}</MarketText><MarketText variant="muted">{item.description}</MarketText><MarketText>{item.isDemo ? 'Example price: ' : ''}{money(item.pricePaise)}</MarketText><MarketButton label={demo || item.isDemo ? 'Add example to cart' : item.isAvailable ? 'Add to cart' : 'Unavailable'} disabled={(!item.isAvailable && !demo && !item.isDemo) || locked} onPress={() => changeCart(() => addCartItem(cart, item))} /></MarketCard></View>)}</View>
      {!market.menu.length ? <MarketStatus kind="empty" title="No menu items yet" message="Please check back later." /> : null}</>}
    </View> : null}
    {page === 'Cart' ? <View style={{ gap: 16 }}><MarketText variant="heading">{demo ? 'Sample cart' : 'Your cart'}</MarketText>{demo ? <MarketText variant="muted">Example items and prices are for browsing only. Checkout is unavailable.</MarketText> : null}{!cart.length ? <MarketStatus kind="empty" title="Your cart is empty" message="Explore the menu to get started." /> : cart.map(line => <MarketCard key={line.item.id}><MarketText variant="heading">{line.item.name}</MarketText><MarketText>{money(line.item.pricePaise)} × {line.quantity} = {money(line.item.pricePaise * line.quantity)}</MarketText><View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}><MarketButton label={`Remove one ${line.item.name}`} variant="secondary" disabled={locked} onPress={() => changeCart(() => line.quantity === 1 ? removeCartItem(cart, line.item.id) : setCartItemQuantity(cart, line.item.id, line.quantity - 1))} /><MarketButton label={`Add one ${line.item.name}`} variant="secondary" disabled={locked || line.quantity >= 10} onPress={() => changeCart(() => setCartItemQuantity(cart, line.item.id, line.quantity + 1))} /></View></MarketCard>)}
      {cart.length ? <MarketCard><MarketText variant="heading">Delivery details</MarketText><MarketText>Subtotal: {money(cartSubtotalPaise(cart))}</MarketText><MarketText>Delivery fee: {money(market.business?.deliveryFeePaise ?? 0)}</MarketText><MarketText>Total: {money(cartSubtotalPaise(cart) + (market.business?.deliveryFeePaise ?? 0))}</MarketText><MarketText variant="muted">Payment: cash on delivery. Final amounts are confirmed by the restaurant.</MarketText><MarketField label="Name" value={details.name} editable={!locked} onChangeText={name => setDetails({ ...details, name })} /><MarketField label="Mobile number" value={details.phone} editable={!locked} keyboardType="phone-pad" onChangeText={phone => setDetails({ ...details, phone })} /><MarketField label="Delivery address" value={details.addressLine} editable={!locked} multiline onChangeText={addressLine => setDetails({ ...details, addressLine })} /><MarketButton variant="secondary" label={busy ? 'Checking…' : 'Check my delivery location'} disabled={busy || locked || demo} onPress={() => void locate()} />{eligible ? <MarketText>Delivery location confirmed. Refresh if your location changes.</MarketText> : null}<MarketButton label={busy ? 'Please wait…' : 'Place order'} disabled={busy || locked || demo || !market.business?.orderingEnabled} onPress={() => void checkout()} />{!market.business?.orderingEnabled && !demo ? <MarketText>Ordering is currently unavailable.</MarketText> : null}</MarketCard> : null}
    </View> : null}
    {page === 'Account' ? <AuthPanel market={market} /> : null}
    {page === 'Orders' ? <View style={{ gap: 16 }}><MarketText variant="heading">Your orders</MarketText>{!market.session ? <MarketCard><MarketText>Sign in to see your orders.</MarketText><MarketButton label="Sign in" onPress={() => setPage('Account')} /></MarketCard> : <><MarketButton label="Refresh orders" variant="secondary" onPress={() => void market.refreshOrders()} />{(receipt && !market.orders.some(o => o.id === receipt.id) ? [receipt, ...market.orders] : market.orders).map(order => <MarketCard key={order.id}><MarketText variant="heading">Order {order.id.slice(0, 8)}</MarketText><MarketText>Status: {order.status.replaceAll('_', ' ')}</MarketText><MarketText variant="muted">{new Date(order.createdAtISO).toLocaleString()}</MarketText>{order.lines.map(line => <MarketText key={line.menuItemId}>{line.quantity} × {line.name} · {money(line.lineTotalPaise)}</MarketText>)}<MarketText>Delivery: {money(order.deliveryFeePaise)} · Total: {money(order.totalPaise)}</MarketText><MarketText variant="muted">{order.delivery.name} · {order.delivery.addressLine}</MarketText>{order.history?.map((event, i) => <MarketText key={`${event.createdAtISO}-${i}`} variant="muted">{event.status.replaceAll('_', ' ')} · {new Date(event.createdAtISO).toLocaleString()}</MarketText>)}</MarketCard>)}{!market.orders.length && !receipt ? <MarketStatus kind="empty" title="No orders yet" /> : null}</>}</View> : null}
  </View>;
}
