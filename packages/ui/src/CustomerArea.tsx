import { useEffect, useRef, useState, type ComponentRef } from 'react';
import { Platform, Pressable, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import { addCartItem, cartSubtotalPaise, formatINRFromPaise, removeCartItem, setCartItemQuantity, type BusinessSlug, type CartLine, type LocationFix, type MenuItem, type Order, type SavedAddress } from '@market/core';
import { MarketButton, MarketCard, MarketField, MarketStatus, MarketText } from './components';
import { CheckoutAddressDialogs, CheckoutAddressSummary, OrderConfirmationSheet, useCheckoutAddresses } from './CheckoutAddress';
import { addressChangedMessage, confirmationCopy, confirmationFor, outsideAreaMessage, phoneFixTimeoutMs, validateContact, withTimeout, type OrderConfirmation } from './checkout-model';
import { MarketFontsProvider, useMarketTheme } from './theme';
import { useBrandFonts } from './brand-fonts';
import { BrandWelcome, useWelcome } from './CustomerBrand';
import { deliveryAddressLine } from './address-model';
import { AuthPanel } from './AuthPanel';
import { attemptKey, freezeAttempt, isDefiniteOrderRejection, orderInput, readAttempt, sameIdentity, type CheckoutAttempt } from './checkout-state';
import { prepareAttempt, withCheckoutGuard } from './checkout-guard';
import { requestLocation } from './location';
import { messageOf, useMarket } from './useMarket';
import { CustomerNavigation, type CustomerScreen } from './CustomerNavigation';
import { CustomerHistory, CustomerOrderDetail, type ReorderAction } from './CustomerOrders';
import { useCustomerCart } from './useCustomerCart';
import { PricingChangedError, ServiceError } from '@market/services';
import { capturePricing, revisedLines, visibleQuote, type RevisedQuote } from './pricing-model';
import { RevisedPricing } from './RevisedPricing';
import { cartKey, readCart } from './cart-state';
import { DietMark } from './DietMark';
import { CartaHeader } from './CustomerCarta';
import { MenuBody, type MenuViewport } from './CustomerMenu';
import { DishDetails } from './DishDetails';
import { capturePanelFocus, restorePanelFocus } from './AccessiblePanel';
import { ReorderNotice, ReorderPanel } from './ReorderPanel';
import { CustomerLegal, CustomerSupport } from './CustomerSupport';
import { CustomerAddresses } from './CustomerAddresses';
import { RestaurantNotice, closedMessage } from './RestaurantNotice';

const money = formatINRFromPaise;
export function CustomerArea({ businessId }: { businessId: BusinessSlug }) {
  const market = useMarket(businessId); const { colors, name, menuLayout } = useMarketTheme(); const { width } = useWindowDimensions();
  const fonts = useBrandFonts(businessId); const welcome = useWelcome(businessId);
  const [selectedDish, setSelectedDish] = useState<{ id: string; identity: typeof market.identity.current } | null>(null);
  const dishTrigger = useRef<HTMLElement | null>(null);
  const [viewportRevision, setViewportRevision] = useState(0);
  const closeDish = () => { setSelectedDish(null); restorePanelFocus(dishTrigger.current); };
  useEffect(() => { setSelectedDish(null); }, [businessId, market.identityVersion]);
  const scrollRef = useRef<ComponentRef<typeof ScrollView>>(null); const viewportListener = useRef<((viewport: MenuViewport) => void) | null>(null);
  const navigation = useRef<{ go: (path: string) => void; login: (next: string) => void } | null>(null);
  const draft = useCustomerCart(businessId, market.session?.user.id ?? null, market.authReady, market.identityVersion, market.menu, !!market.business && !market.loading);
  const currentDish = selectedDish && sameIdentity(selectedDish.identity, market.identity.current) ? draft.menu.find(item => item.id === selectedDish.id) : undefined;
  const [reorder, setReorder] = useState<{ order: Order; restoreFocus: () => void; identity: typeof market.identity.current } | null>(null);
  const [cartMessage, setCartMessage] = useState('');
  const startReorder: ReorderAction = (order, restoreFocus) => { if (!reorder) setReorder({ order, restoreFocus, identity: market.identity.current }); };
  const closeReorder = () => { setReorder(null); reorder?.restoreFocus(); };
  const currentReorder = reorder && sameIdentity(reorder.identity, market.identity.current) ? reorder : null;
  const { cart, setCart, details, setDetails, receipt, setReceipt } = draft;
  const [busy, setBusy] = useState(false); const [localError, setLocalError] = useState('');
  const sending = useRef(false), placeTrigger = useRef<HTMLElement | null>(null);
  const [confirming, setConfirming] = useState<{ address: SavedAddress; fix: LocationFix | null; confirmation: Exclude<OrderConfirmation, { kind: 'direct' }>; totalPaise: number } | null>(null);
  // A sheet quotes the total it was opened with: if the cart changes while it is open, close it so a stale total is never confirmed.
  const cartSignature = JSON.stringify([market.business?.deliveryFeePaise, market.business?.minOrderPaise, cart.map(line => [line.item.id, line.quantity, line.item.pricePaise])]);
  useEffect(() => { setConfirming(null); }, [cartSignature]);
  const [revision, setRevision] = useState<RevisedQuote | null>(null);
  const [closedRefusal, setClosedRefusal] = useState<{ business: typeof market.business; identity: typeof market.identity.current } | null>(null);
  const quote = visibleQuote(revision, market.identity.current, market.authReady);
  useEffect(() => { setRevision(null); setLocalError(''); setReorder(null); setCartMessage(''); setConfirming(null); }, [businessId, market.identityVersion]);
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;
    const changed = (event: StorageEvent) => {
      if (event.key === null || event.key === cartKey(businessId)) setRevision(current => current && current.sourceCart !== event.newValue ? null : current);
    };
    window.addEventListener('storage', changed);
    return () => window.removeEventListener('storage', changed);
  }, [businessId]);
  const demo = market.services.mode === 'demo' || !!market.business?.isDemo;
  // Addresses are only read once there is something to order; the top bar shows the selected one from then on.
  const addrs = useCheckoutAddresses(market, !demo && !!market.session && market.authReady && cart.length > 0);
  const refused = !!closedRefusal && closedRefusal.business === market.business && sameIdentity(closedRefusal.identity, market.identity.current);
  const orderingAllowed = demo || (market.businessReady && !!market.business?.orderingEnabled && market.business.acceptingOrders && !refused);
  const orderingMessage = refused || market.businessReady && market.business && !market.business.acceptingOrders ? closedMessage(businessId)
    : market.catalogError ? 'Could not confirm whether the restaurant is taking orders. Refresh the restaurant status before adding dishes.'
    : !market.businessReady ? 'Checking whether the restaurant is taking orders…' : 'Ordering is currently unavailable.';
  const ordering = useRef({ allowed: orderingAllowed, business: market.business, message: orderingMessage });
  ordering.current = { allowed: orderingAllowed, business: market.business, message: orderingMessage };
  const requireOrdering = () => { if (!ordering.current.allowed) throw new Error(ordering.current.message); };
  const locked = !!quote || !!market.attempt || !market.attemptReady || !!market.storageError || !draft.ready || draft.saving || !!draft.cartError;
  const unavailable = cart.some(line => !line.item.isAvailable && !line.item.isDemo);
  const subtotal = cartSubtotalPaise(cart.filter(line => line.item.isAvailable || line.item.isDemo));
  const changeCart = (fn: (lines: CartLine[]) => CartLine[], adding = false) => { void draft.changeCart(lines => { if (adding) requireOrdering(); return fn(lines); }).then(() => setLocalError('')).catch(e => setLocalError(messageOf(e))); };
  const send = async (saved: CheckoutAttempt) => {
    if (market.identity.current.userId !== saved.userId) { navigation.current?.login('/cart'); setLocalError('Sign in with the account used for this order to recover it.'); return; } const started = market.identity.current;
    try {
      const order = await market.services.placeOrder(orderInput(saved));
      if (!sameIdentity(started, market.identity.current)) return;
      setReceipt(order); await draft.resetCart(); if (!sameIdentity(started, market.identity.current)) return; navigation.current?.go(`/orders/${order.id}`);
      try { await AsyncStorage.removeItem(attemptKey(businessId)); market.setAttempt(null); }
      catch { setLocalError('Your order was confirmed, but this device could not clear its saved attempt. Retry recovery before placing another order.'); }
      void market.refreshOrders();
    } catch (e) {
      if (!sameIdentity(started, market.identity.current)) return;
      if (e instanceof PricingChangedError) {
        try {
          const sourceCart = await AsyncStorage.getItem(cartKey(businessId));
          const source = readCart(sourceCart, businessId);
          await AsyncStorage.removeItem(attemptKey(businessId));
          market.setAttempt(null);
          if (!sameIdentity(started, market.identity.current)) return;
          if (!sourceCart || source?.ownerId !== saved.userId || JSON.stringify(source.lines.map(line => [line.item.id, line.quantity])) !== JSON.stringify(saved.lines.map(line => [line.item.id, line.quantity]))) {
            setLocalError('Your cart changed in another window. Review it before ordering.'); return;
          }
          setRevision({ original: saved, pricing: e.pricing, identity: started, sourceCart });
          navigation.current?.go('/cart');
        } catch { setLocalError('The revised quote could not be saved safely. Retry recovery before placing another order.'); }
      } else if (isDefiniteOrderRejection(e)) {
        const code = e instanceof ServiceError ? e.code : '';
        const closed = code === 'NOT_ACCEPTING_ORDERS', changed = code === 'ADDRESS_CHANGED', outside = code === 'DELIVERY_UNAVAILABLE';
        if (closed) setClosedRefusal({ business: ordering.current.business, identity: started });
        try { await AsyncStorage.removeItem(attemptKey(businessId)); market.setAttempt(null); if (sameIdentity(started, market.identity.current)) { await setCart(saved.lines); if (!sameIdentity(started, market.identity.current)) return; setDetails({ name: saved.delivery.name, phone: saved.delivery.phone });
          if (changed) addrs.refresh();
          if (outside) { addrs.select(null); addrs.refresh(); }
          setLocalError(closed ? '' : changed ? addressChangedMessage : outside ? outsideAreaMessage : `${messageOf(e)} Please check your details and try again.`); if (closed) market.load(); } }
        catch { setLocalError('The order was declined, but its saved attempt could not be cleared. Retry recovery before placing another order.'); }
      } else setLocalError(`${messageOf(e)} The result may be uncertain. Retry this same order to recover its status.`);
    }
  };
  const guarded = async (work: () => Promise<void>) => {
    if (sending.current) return; sending.current = true; setBusy(true); setLocalError('');
    try { await withCheckoutGuard(businessId, Platform.OS === 'web', work); }
    catch (e) { setLocalError(messageOf(e)); } finally { sending.current = false; setBusy(false); }
  };
  /** Everything that must hold before an order goes out; run again under the guard after any confirmation. */
  const validateOrder = () => {
    requireOrdering();
    if (!market.business || demo || !market.business.orderingEnabled) throw new Error('Ordering is currently unavailable.');
    if (!cart.length) throw new Error('Add an item to your cart first.');
    if (cart.some(line => line.item.isDemo || !line.item.isAvailable)) throw new Error('Remove sample or unavailable items before ordering.');
    if (cartSubtotalPaise(cart) < market.business.minOrderPaise) throw new Error(`The minimum order is ${money(market.business.minOrderPaise)}.`);
    const userId = market.session?.user.id;
    if (!userId || market.identity.current.userId !== userId) throw new Error('Sign in before placing your order.');
    return { userId, contact: validateContact(details), pricing: capturePricing(cart, market.business.deliveryFeePaise, market.business.minOrderPaise) };
  };
  const submit = (address: SavedAddress, fix: LocationFix | null) => guarded(async () => {
    const { userId, contact, pricing } = validateOrder();
    const result = await prepareAttempt(AsyncStorage, businessId, () => { requireOrdering(); return freezeAttempt({ businessId, userId, idempotencyKey: Crypto.randomUUID(), lines: cart, pricing, delivery: contact, savedAddress: { id: address.id, version: address.version }, location: fix }); });
    market.setAttempt(result.attempt);
    if (result.existing) { setLocalError('An earlier order needs confirmation. Retry its recovery before placing another order.'); return; }
    await send(result.attempt);
  });
  const checkout = async () => {
    if (sending.current || locked) return;
    if (!market.session) { navigation.current?.login('/cart'); setLocalError('Sign in before placing your order. Your cart will stay here.'); return; }
    const address = addrs.selected;
    placeTrigger.current = capturePanelFocus();
    if (!address) { setLocalError(addrs.addresses?.length ? 'Choose a delivery address first.' : 'Add a delivery address first.'); addrs.open(); return; }
    sending.current = true; setBusy(true); setLocalError('');
    let next: { fix: LocationFix | null; confirmation: OrderConfirmation; totalPaise: number } | null = null;
    try {
      const { pricing } = validateOrder();
      // A current phone location only decides whether to ask; being denied or unavailable never blocks the order.
      const fix = await withTimeout(requestLocation(), phoneFixTimeoutMs);
      next = { fix, confirmation: confirmationFor(fix, address), totalPaise: pricing.total_paise };
    } catch (e) { setLocalError(messageOf(e)); } finally { sending.current = false; setBusy(false); }
    if (!next) return;
    if (next.confirmation.kind === 'direct') await submit(address, next.fix);
    else setConfirming({ address, fix: next.fix, confirmation: next.confirmation, totalPaise: next.totalPaise });
  };
  const acceptRevision = () => { void guarded(async () => {
    requireOrdering();
    const current = visibleQuote(revision, market.identity.current, market.authReady);
    if (!current || current.pricing.subtotal_paise < current.pricing.min_order_paise) return;
    // Read under the checkout guard: a preceding confirmation clears the shared
    // cart before releasing this guard, even if its storage event is still queued.
    if (await AsyncStorage.getItem(cartKey(businessId)) !== current.sourceCart) {
      setRevision(null); throw new Error('Your cart changed in another window. Review it before ordering.');
    }
    const result = await prepareAttempt(AsyncStorage, businessId, () => {
      requireOrdering();
      if (!sameIdentity(current.identity, market.identity.current)) throw new Error('Your account changed. Review your cart before ordering.');
      return freezeAttempt({ ...current.original, idempotencyKey: Crypto.randomUUID(), lines: revisedLines(current), pricing: current.pricing });
    });
    market.setAttempt(result.attempt); setRevision(null);
    if (result.existing) { setLocalError('An earlier order needs confirmation. Retry its recovery before placing another order.'); return; }
    await send(result.attempt);
  }); };
  const editRevision = () => { void guarded(async () => {
    const current = visibleQuote(revision, market.identity.current, market.authReady);
    if (!current) return;
    await setCart(revisedLines(current));
    if (!sameIdentity(current.identity, market.identity.current)) return;
    setRevision(null); setDetails({ name: current.original.delivery.name, phone: current.original.delivery.phone });
    if (current.original.savedAddress) addrs.select(current.original.savedAddress.id);
  }); };
  const retry = () => { void guarded(async () => {
    const saved = readAttempt(await AsyncStorage.getItem(attemptKey(businessId)), businessId);
    market.setAttempt(saved);
    if (!saved) { setLocalError('This order was already recovered. Refresh your orders.'); return; }
    await send(saved);
  }); };
  const openDish = (item: MenuItem) => { dishTrigger.current = capturePanelFocus(); setSelectedDish({ id: item.id, identity: market.identity.current }); };
  const addDetails = async (quantity: number) => {
    requireOrdering();
    if (locked || !currentDish?.isAvailable) throw new Error('This dish or your cart is currently unavailable.');
    const started = market.identity.current;
    let applied = false;
    await draft.changeCart(lines => {
      requireOrdering();
      if (!sameIdentity(started, market.identity.current)) throw new Error('Your account changed. Review your cart before adding dishes.');
      const next = addCartItem(lines, currentDish, quantity);
      applied = true; return next;
    });
    if (!applied || !sameIdentity(started, market.identity.current)) throw new Error('Your cart or account changed. Review it before adding this dish.');
    setLocalError('');
  };
  const removeOne = (item: MenuItem) => changeCart(lines => { const current = lines.find(line => line.item.id === item.id); return !current ? lines : current.quantity > 1 ? setCartItemQuantity(lines, item.id, current.quantity - 1) : removeCartItem(lines, item.id); });
  const carta = menuLayout === 'carta', edge = width >= 760 ? 40 : 20;
  const facts = market.business ? [market.business.minOrderPaise > 0 ? `Min. order ${money(market.business.minOrderPaise)}` : '', `Delivery ${money(market.business.deliveryFeePaise)}`, 'Cash on delivery'].filter(Boolean).join(' · ') : '';
  const menuProps = { items: draft.menu, cart, contentWidth: Math.min(width, 1120) - 2 * edge, orderingAllowed, demo, locked, viewportRevision, onOpen: openDish, onAdd: (item: MenuItem) => changeCart(lines => addCartItem(lines, item), true), onRemove: removeOne };
  const render = (page: CustomerScreen, orderId?: string) => <ScrollView ref={scrollRef} keyboardShouldPersistTaps="handled" scrollEventThrottle={64} onScroll={event => { if (Platform.OS !== 'web') setViewportRevision(event.nativeEvent.contentOffset.y); if (page === 'Menu') viewportListener.current?.({ y: event.nativeEvent.contentOffset.y, height: event.nativeEvent.layoutMeasurement.height, contentHeight: event.nativeEvent.contentSize.height }); if (page === 'Orders' && !market.olderOrdersError) { const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent; if (contentOffset.y + layoutMeasurement.height >= contentSize.height - 180) void market.loadOlderOrders(); } }} contentContainerStyle={{ width: '100%', maxWidth: 1120, alignSelf: 'center', paddingHorizontal: edge, paddingTop: carta && page === 'Menu' ? 0 : 28, paddingBottom: 28, gap: 24 }}>

    {page === 'Menu' && carta ? <CartaHeader name={name} {...menuProps} edge={width >= 760 ? 0 : edge} /> : null}
    {page === 'Menu' && !carta ? <View style={{ gap: 6 }}><Text accessibilityRole="header" aria-level={1} style={{ fontSize: 34, lineHeight: 42, color: colors.ink, ...(fonts.heading ? { fontFamily: fonts.heading } : { fontWeight: '700' as const }) }}>{name}</Text>{facts ? <MarketText variant="muted">{facts}</MarketText> : null}</View> : null}

    {page !== 'Menu' && page !== 'Help' && page !== 'Privacy' && page !== 'Terms' && page !== 'Order' && page !== 'Addresses' ? <View style={{ gap: 8 }}><MarketText variant="eyebrow">{name}</MarketText><MarketText variant="title">Good food starts here.</MarketText><MarketText variant="muted">Explore the menu and find something for your table.</MarketText></View> : null}

    {!demo && (page === 'Menu' || page === 'Cart') ? <RestaurantNotice businessId={businessId} business={market.business} ready={market.businessReady} error={market.catalogError} retry={market.load} refused={refused} /> : null}
    {demo ? <MarketCard><MarketText variant="heading">Sample menu</MarketText><MarketText variant="muted">Items and prices shown as examples are for browsing only. Ordering is unavailable.</MarketText></MarketCard> : null}
    {market.notice ? <MarketText>{market.notice}</MarketText> : null}
    {draft.cartError ? <MarketCard><Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={{ color: colors.danger }}>{draft.cartError}</Text><MarketButton label="Retry saved cart" variant="secondary" onPress={() => { void draft.retryCart().catch(() => {}); }} /><MarketButton label="Start new cart" variant="secondary" onPress={() => { void draft.resetCart().catch(() => {}); }} /></MarketCard> : null}
    {(market.error && (market.error !== market.catalogError || (page !== 'Menu' && page !== 'Cart'))) || market.storageError || (localError && !(page === 'Menu') && (page !== 'Cart' || !cart.length)) ? <MarketCard><Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={{ color: colors.danger, fontSize: 15, lineHeight: 23 }}>{market.storageError || localError || market.error}</Text>{market.error ? <MarketButton label="Retry loading" variant="secondary" onPress={() => void market.load()} /> : null}</MarketCard> : null}
    {market.storageError ? <MarketText>Saved checkout state is unavailable. Ordering is paused to avoid creating a duplicate order.</MarketText> : null}
    {market.attempt ? <MarketCard><MarketText variant="heading">Order awaiting confirmation</MarketText><MarketText>Your previous order may have been received. Retry the same request to recover its result before changing the cart or placing another order.</MarketText>{market.authReady && market.session?.user.id === market.attempt.userId ? market.attempt.lines.map(line => <View key={line.item.id} style={{ gap: 4 }}><MarketText>{line.quantity} × {line.item.name} · {money(line.item.pricePaise * line.quantity)}</MarketText><DietMark diet={line.item.diet} /></View>) : null}<MarketButton label={busy ? 'Checking…' : 'Retry order recovery'} disabled={busy} onPress={retry} /></MarketCard> : null}
    {quote ? <RevisedPricing quote={quote} busy={busy || !!market.attempt || !draft.ready} orderingAllowed={orderingAllowed} accept={acceptRevision} edit={editRevision} /> : null}
    {page === 'Menu' ? (market.loading ? <MarketStatus kind="loading" title="Loading menu" /> : <MenuBody variant={menuLayout} facts={facts} businessId={businessId} {...menuProps} bleed={edge} scrollRef={scrollRef} viewportListener={viewportListener} message={localError} onDismissMessage={() => setLocalError('')} />) : null}
    {page === 'Cart' ? <View style={{ gap: 16 }}><MarketText variant="heading">{demo ? 'Sample cart' : 'Your cart'}</MarketText>{cartMessage ? <ReorderNotice message={cartMessage} /> : null}{demo ? <MarketText variant="muted">Example items and prices are for browsing only. Checkout is unavailable.</MarketText> : null}{!draft.ready && !draft.cartError ? <MarketStatus kind="loading" title="Loading your cart and menu" /> : !cart.length ? <MarketStatus kind="empty" title="Your cart is empty" message="Explore the menu to get started." /> : cart.map(line => <MarketCard key={line.item.id}><MarketText variant="heading">{line.item.name}</MarketText><DietMark diet={line.item.diet} /><MarketText>{!line.item.isAvailable && !line.item.isDemo ? 'Last shown price: ' : ''}{money(line.item.pricePaise)} × {line.quantity} = {money(line.item.pricePaise * line.quantity)}</MarketText>{!line.item.isAvailable && !line.item.isDemo ? <><MarketText>This dish is unavailable. Remove it before checkout.</MarketText><MarketButton label={`Remove unavailable ${line.item.name}`} variant="secondary" disabled={locked} onPress={() => changeCart(lines => removeCartItem(lines, line.item.id))} /></> : null}<View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}><MarketButton label={`Remove one ${line.item.name}`} variant="secondary" disabled={locked} onPress={() => changeCart(lines => { const current = lines.find(value => value.item.id === line.item.id); return current && current.quantity > 1 ? setCartItemQuantity(lines, line.item.id, current.quantity - 1) : removeCartItem(lines, line.item.id); })} />{orderingAllowed ? <MarketButton label={`Add one ${line.item.name}`} variant="secondary" disabled={locked || line.quantity >= 10 || (!line.item.isAvailable && !demo)} onPress={() => changeCart(lines => { const current = lines.find(value => value.item.id === line.item.id); return current ? setCartItemQuantity(lines, line.item.id, current.quantity + 1) : lines; }, true)} /> : null}</View></MarketCard>)}
      {cart.length ? <MarketCard><MarketText variant="heading">Delivery details</MarketText><MarketText>{unavailable ? 'Subtotal (available dishes)' : 'Subtotal'}: {money(subtotal)}</MarketText><MarketText>Delivery fee: {money(market.business?.deliveryFeePaise ?? 0)}</MarketText><MarketText>Minimum order: {money(market.business?.minOrderPaise ?? 0)}</MarketText><MarketText>Total: {money(subtotal + (market.business?.deliveryFeePaise ?? 0))}</MarketText><MarketText variant="muted">Payment: cash on delivery. Any price changes require your acceptance before ordering.</MarketText><MarketField label="Name" value={details.name} editable={!locked} onChangeText={name => setDetails({ ...details, name })} /><MarketField label="Mobile number" value={details.phone} editable={!locked} keyboardType="phone-pad" onChangeText={phone => setDetails({ ...details, phone })} /><CheckoutAddressSummary ctrl={addrs} />{orderingAllowed ? <MarketButton label={busy ? 'Please wait…' : market.session && !addrs.selected ? 'Choose a delivery address' : 'Place order'} disabled={busy || locked || unavailable || demo || !market.business?.orderingEnabled || (!!market.session && addrs.addresses === null && !addrs.error)} onPress={() => void checkout()} /> : null}{localError ? <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={{ color: colors.danger, fontSize: 15, lineHeight: 23 }}>{localError}</Text> : null}</MarketCard> : null}
    </View> : null}
    {page === 'Account' || page === 'Login' ? <AuthPanel market={{ ...market, preferences: { ...market.preferences, signOut: async () => { draft.clearForSignOut(); await market.preferences.signOut(); } } }} /> : null}
    {page === 'Orders' ? <CustomerHistory market={market} go={path => navigation.current?.go(path)} onReorder={startReorder} /> : null}
    {page === 'Order' ? <CustomerOrderDetail market={market} id={orderId ?? ''} receipt={receipt} onReorder={startReorder} onHelp={() => navigation.current?.go(`/help?id=${orderId}`)} /> : null}
    {page === 'Help' ? <CustomerSupport businessId={businessId} market={market} go={path => navigation.current?.go(path)} orderReference={orderId} /> : null}
    {page === 'Privacy' || page === 'Terms' ? <CustomerLegal businessId={businessId} kind={page === 'Privacy' ? 'privacy' : 'terms'} go={path => navigation.current?.go(path)} /> : null}
    {page === 'Addresses' ? <CustomerAddresses market={market} /> : null}
    {page === 'Profile' || page === 'Notifications' ? <MarketCard><MarketText variant="heading">{page === 'Profile' ? 'Edit profile' : 'Notifications'}</MarketText><MarketText>{page === 'Profile' ? 'Profile editing is not available yet. Your account settings are available below.' : 'Your notification inbox is not available yet. Order updates remain available in your order history.'}</MarketText>{page === 'Profile' ? <MarketButton label="Account settings" onPress={() => navigation.current?.go('/account')} /> : null}<MarketButton label="Browse menu" variant="secondary" onPress={() => navigation.current?.go('/')} /></MarketCard> : null}
  </ScrollView>;
  const sheet = confirming ? confirmationCopy(confirming.confirmation, confirming.address, confirming.totalPaise) : null;
  // Only the root Menu route waits for the first-launch welcome; deep links (/privacy, /login, orders) render normally.
  const welcomeScreen = welcome.state === 'show' ? <BrandWelcome onContinue={welcome.dismiss} /> : welcome.state === 'checking' ? <View style={{ flex: 1, backgroundColor: colors.background }} /> : null;
  return <MarketFontsProvider value={fonts}><CheckoutAddressDialogs ctrl={addrs} />{confirming && sheet ? <OrderConfirmationSheet copy={sheet} busy={busy} dismiss={() => setConfirming(null)} change={() => { setConfirming(null); addrs.open(placeTrigger.current); }} confirm={() => { const chosen = confirming; setConfirming(null);
    // The sheet quoted a total before the phone's location was awaited; never send a different one than was shown.
    try { if (validateOrder().pricing.total_paise !== chosen.totalPaise) { setLocalError('Your total changed. Please check your order and try again.'); return; } } catch (e) { setLocalError(messageOf(e)); return; }
    void submit(chosen.address, chosen.fix); }} /> : null}<CustomerNavigation signOut={async () => { draft.clearForSignOut(); await market.preferences.signOut(); }} market={market} render={render} controls={navigation} cartCount={cart.reduce((n, line) => n + line.quantity, 0)} onReorder={startReorder} reorderOpen={!!currentReorder} orderingAllowed={orderingAllowed} deliveryLine={deliveryAddressLine(demo ? null : addrs.selected)} welcome={welcomeScreen} />{currentDish ? <DishDetails key={`${market.identityVersion}-${currentDish.id}`} item={currentDish} inCart={cart.find(line => line.item.id === currentDish.id)?.quantity ?? 0} locked={locked} orderingAllowed={orderingAllowed} orderingMessage={orderingMessage} onAdd={addDetails} onClose={closeDish} /> : null}{currentReorder ? <ReorderPanel key={`${market.identityVersion}-${currentReorder.order.id}`} businessId={businessId} order={currentReorder.order} market={market} draft={draft} paused={!!quote} orderingAllowed={orderingAllowed} orderingMessage={orderingMessage} onClose={closeReorder} onSaved={message => { setReorder(null); setCartMessage(message); setLocalError(''); navigation.current?.go('/cart'); }} /> : null}</MarketFontsProvider>;
}
