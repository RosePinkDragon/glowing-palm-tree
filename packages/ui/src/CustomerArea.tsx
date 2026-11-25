import { useEffect, useRef, useState, type ComponentRef } from 'react';
import { Platform, Pressable, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import { addCartItem, cartSubtotalPaise, formatINRFromPaise, removeCartItem, setCartItemQuantity, type BusinessSlug, type CartLine, type LocationFix, type MenuItem, type Order, type SavedAddress } from '@market/core';
import { MarketButton, MarketCard, MarketStatus, MarketText } from './components';
import { CheckoutAddressDialogs, focusAddressStep, OrderConfirmationSheet, useCheckoutAddresses } from './CheckoutAddress';
import { addressChangedMessage, confirmationCopy, confirmationFor, outsideAreaMessage, phoneFixTimeoutMs, validateContact, withTimeout, type OrderConfirmation } from './checkout-model';
import { MarketFontsProvider, useMarketTheme } from './theme';
import { useBrandFonts } from './brand-fonts';
import { BrandWelcome, useWelcome } from './CustomerBrand';
import { deliveryAddressLine } from './address-model';
import { AuthPanel } from './AuthPanel';
import { LeaveRestaurant } from './LeaveRestaurant';
import { checkoutLifecycleCopy } from './leave-model';
import { attemptKey, freezeAttempt, isDefiniteOrderRejection, orderInput, readAttempt, sameIdentity, type CheckoutAttempt } from './checkout-state';
import { prepareAttempt, withCheckoutGuard } from './checkout-guard';
import { requestLocation } from './location';
import { messageOf, useMarket } from './useMarket';
import { CustomerNavigation, type CustomerScreen } from './CustomerNavigation';
import { CustomerHistory, CustomerOrderDetail, type ReorderAction } from './CustomerOrders';
import { useCustomerCart } from './useCustomerCart';
import { OfferError, PricingChangedError, ServiceError } from '@market/services';
import { traced, type EventName } from '@market/notifications';
import { capturePricing, revisedLines, visibleQuote, type RevisedQuote } from './pricing-model';
import { RevisedPricing } from './RevisedPricing';
import { cartKey, readCart } from './cart-state';
import { DietMark } from './DietMark';
import { CartaHeader } from './CustomerCarta';
import { MenuBody, type MenuViewport } from './CustomerMenu';
import { DishDetails } from './DishDetails';
import { capturePanelFocus, restorePanelFocus } from './AccessiblePanel';
import { ReorderPanel } from './ReorderPanel';
import { CustomerLegal, CustomerSupport } from './CustomerSupport';
import { CustomerAddresses } from './CustomerAddresses';
import { CustomerNotifications } from './CustomerNotifications';
import { RestaurantNotice, closedMessage } from './RestaurantNotice';
import { CartPage } from './CustomerCart';
import { restoreLine, soleRemoval, type Removal } from './removal-model';
import { RemovalAnnouncer, RemovalUndoBar, focusRestored, useRemovalUndo } from './RemovalUndo';
import { CartOffer, OfferBanner, useOfferQuote } from './CartOffer';
import { billTotals, quoteSignature, quotedOffer } from './offer-model';

const money = formatINRFromPaise;
/** Sends one analytics event when it mounts (consent permitting). Effects re-run under StrictMode, so the once-guard lives in fireOnce, not here. */
function SendEvent({ name, consented, fire }: { name: EventName; consented: boolean; fire: (name: EventName) => void }) {
  useEffect(() => { if (consented) fire(name); }, [consented, name, fire]);
  return null;
}
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
  const demo = market.services.mode === 'demo' || !!market.business?.isDemo;
  const draft = useCustomerCart(businessId, market.session?.user.id ?? null, market.authReady, market.identityVersion, market.menu, !!market.business && !market.loading, { enabled: !demo && !!market.business && !market.loading, phone: market.session?.user.phone });
  const currentDish = selectedDish && sameIdentity(selectedDish.identity, market.identity.current) ? draft.menu.find(item => item.id === selectedDish.id) : undefined;
  const [reorder, setReorder] = useState<{ order: Order; restoreFocus: () => void; identity: typeof market.identity.current } | null>(null);
  const [cartMessage, setCartMessage] = useState('');
  // Status notes (not errors): the post-leave notice clears on the next sign-in; the checkout rejoin note on any identity change.
  const [leftNotice, setLeftNotice] = useState(''), [lifecycleNote, setLifecycleNote] = useState('');
  useEffect(() => { if (market.session) setLeftNotice(''); }, [market.session]);
  const startReorder: ReorderAction = (order, restoreFocus) => { if (!reorder) setReorder({ order, restoreFocus, identity: market.identity.current }); };
  const closeReorder = () => { setReorder(null); reorder?.restoreFocus(); };
  const currentReorder = reorder && sameIdentity(reorder.identity, market.identity.current) ? reorder : null;
  const { cart, setCart, details, setDetails, receipt, setReceipt } = draft;
  const [busy, setBusy] = useState(false); const [localError, setLocalError] = useState('');
  const sending = useRef(false), placedAsMe = useRef(false), placeTrigger = useRef<HTMLElement | null>(null);
  const [confirming, setConfirming] = useState<{ address: SavedAddress; fix: LocationFix | null; confirmation: Exclude<OrderConfirmation, { kind: 'direct' }>; totalPaise: number } | null>(null);
  // A sheet quotes the total it was opened with: if the cart changes while it is open, close it so a stale total is never confirmed.
  const cartSignature = JSON.stringify([market.business?.deliveryFeePaise, market.business?.minOrderPaise, cart.map(line => [line.item.id, line.quantity, line.item.pricePaise])]);
  useEffect(() => { setConfirming(null); }, [cartSignature]);
  const [revision, setRevision] = useState<RevisedQuote | null>(null);
  const [closedRefusal, setClosedRefusal] = useState<{ business: typeof market.business; identity: typeof market.identity.current } | null>(null);
  const quote = visibleQuote(revision, market.identity.current, market.authReady);
  useEffect(() => { setRevision(null); setLocalError(''); setLifecycleNote(''); setReorder(null); setCartMessage(''); setConfirming(null); }, [businessId, market.identityVersion]);
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;
    const changed = (event: StorageEvent) => {
      if (event.key === null || event.key === cartKey(businessId)) setRevision(current => current && current.sourceCart !== event.newValue ? null : current);
    };
    window.addEventListener('storage', changed);
    return () => window.removeEventListener('storage', changed);
  }, [businessId]);
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
  // #182: signed in, the server prices the cart (discount, offer, nudge); signed out, only the public automatic offers are listed.
  const signedIn = !!market.session && market.authReady, fee = market.business?.deliveryFeePaise ?? 0, minOrder = market.business?.minOrderPaise ?? 0;
  const priced = cart.filter(line => line.item.isAvailable || line.item.isDemo);
  const offers = useOfferQuote({ services: market.services, quoting: !demo && signedIn && draft.ready && !!market.business && priced.length > 0, listing: !demo && market.authReady && !market.session && !!market.business,
    lines: priced, signature: quoteSignature(priced, fee, minOrder), identityKey: `${businessId}:${market.session?.user.id ?? ''}:${market.identityVersion}` });
  const offerTerms = quotedOffer(offers.quote?.pricing), billing = billTotals(subtotal, fee, offerTerms);
  const offerKey = JSON.stringify([offers.code, offers.quote?.pricing.total_paise ?? null]);
  useEffect(() => { setConfirming(null); }, [offerKey]); // a sheet shows the total it was opened with
  // #204: taking a dish's last unit offers Undo, only for this restaurant, account and (not yet ordered) cart.
  const removal = useRemovalUndo(`${businessId}:${market.session?.user.id ?? ''}:${market.identityVersion}:${receipt?.id ?? ''}`);
  const changeCart = (fn: (lines: CartLine[]) => CartLine[], adding = false, applied?: () => void) => { const taken: { removal: Removal | null } = { removal: null }; void draft.changeCart(lines => { if (adding) requireOrdering(); const next = fn(lines); taken.removal = soleRemoval(lines, next); return next; }).then(() => { setLocalError(''); if (taken.removal) removal.offer(taken.removal); applied?.(); }).catch(e => setLocalError(messageOf(e))); };
  const undoRemoval = ({ line, index }: Removal) => { changeCart(lines => { const dish = draft.menu.find(item => item.id === line.item.id); if (lines.some(current => current.item.id === line.item.id)) return lines; if (!dish || !dish.isAvailable) throw new Error(`${line.item.name} is no longer available.`); return restoreLine(lines, addCartItem(lines, dish, line.quantity).find(current => current.item.id === dish.id)!, index); }, true, () => { removal.dismiss(); removal.announce(`Restored ${line.item.name} to your cart.`); focusRestored(line.item.name); }); };
  const undoBar = removal.pending ? <RemovalUndoBar removal={removal.pending} disabled={locked} onUndo={() => undoRemoval(removal.pending!)} onPause={removal.setPaused} /> : null;
  const send = async (saved: CheckoutAttempt) => {
    if (market.identity.current.userId !== saved.userId) { navigation.current?.login('/cart'); setLocalError('Sign in with the account used for this order to recover it.'); return; } const started = market.identity.current;
    try {
      const order = await traced('checkout_submit', () => market.services.placeOrder(orderInput(saved)));
      if (!sameIdentity(started, market.identity.current)) return;
      market.preferences.fireOnce('order_completed', order.id);
      // Only the account holder's own name is remembered, and only when this order was placed as "Me"; a recipient is never stored.
      const remember = placedAsMe.current; placedAsMe.current = false;
      if (remember) void draft.rememberOwnName(saved.userId, saved.delivery.name); // best effort; it never delays the receipt
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
      } else if (e instanceof OfferError) {
        // The quoted offer no longer applies (or the code lookup is rate limited). Nothing was ordered and the key is spent, like pricing_changed:
        // release the attempt, drop the code and show why with the repriced total. The customer must tap Place order again; it is never retried for them.
        try {
          await AsyncStorage.removeItem(attemptKey(businessId)); market.setAttempt(null);
          if (!sameIdentity(started, market.identity.current)) return;
          offers.rejected(e); navigation.current?.go('/cart');
        } catch { setLocalError('The offer changed, but the saved attempt could not be cleared. Retry recovery before placing another order.'); }
      } else if (e instanceof ServiceError && (e.code === 'BUSINESS_JOIN_REQUIRED' || e.code === 'BUSINESS_LIFECYCLE_PENDING')) {
        // The relationship gate runs before the idempotency lookup, so on a replay this does not prove nothing was written: keep the saved attempt and recover the same order.
        const pending = e.code === 'BUSINESS_LIFECYCLE_PENDING'; let rejoined = false;
        if (!pending) { try { await market.services.joinBusiness(); rejoined = true; } catch { /* the note says so */ } }
        if (!sameIdentity(started, market.identity.current)) return;
        setLifecycleNote(checkoutLifecycleCopy(pending ? 'pending' : 'join-required', name, rejoined));
      } else if (isDefiniteOrderRejection(e)) {
        const code = e instanceof ServiceError ? e.code : '';
        const closed = code === 'NOT_ACCEPTING_ORDERS', changed = code === 'ADDRESS_CHANGED', outside = code === 'DELIVERY_UNAVAILABLE';
        if (closed) setClosedRefusal({ business: ordering.current.business, identity: started });
        try { await AsyncStorage.removeItem(attemptKey(businessId)); market.setAttempt(null); if (sameIdentity(started, market.identity.current)) { await setCart(saved.lines); if (!sameIdentity(started, market.identity.current)) return; draft.restoreRecipient(saved.delivery);
          if (changed) addrs.refresh();
          if (outside) { addrs.select(null); addrs.refresh(); }
          setLocalError(closed ? '' : changed ? addressChangedMessage : outside ? outsideAreaMessage : `${messageOf(e)} Please check your details and try again.`); if (closed) market.load(); } }
        catch { setLocalError('The order was declined, but its saved attempt could not be cleared. Retry recovery before placing another order.'); }
      } else setLocalError(`${messageOf(e)} The result may be uncertain. Retry this same order to recover its status.`);
    }
  };
  const guarded = async (work: () => Promise<void>) => {
    if (sending.current) return; sending.current = true; setBusy(true); setLocalError(''); setLifecycleNote('');
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
    // The accepted pricing carries the server's discount and offer (capturePricing), or place_order would refuse any cart an offer applies to.
    if (offers.pending) throw new Error('Updating your offer. Try again in a moment.');
    if (offers.code && !offers.quote) throw new Error('Could not confirm your code. Remove it or try again.');
    if (offers.blocked) throw new Error(offers.shortfall);
    return { userId, contact: validateContact(details), pricing: capturePricing(cart, market.business.deliveryFeePaise, market.business.minOrderPaise, offerTerms), offerCode: offers.code };
  };
  const submit = (address: SavedAddress, fix: LocationFix | null) => guarded(async () => {
    const { userId, contact, pricing, offerCode } = validateOrder();
    const asMe = draft.recipient.mode === 'me';
    const result = await prepareAttempt(AsyncStorage, businessId, () => { requireOrdering(); return freezeAttempt({ businessId, userId, idempotencyKey: Crypto.randomUUID(), lines: cart, pricing, offerCode, delivery: contact, savedAddress: { id: address.id, version: address.version }, location: fix }); });
    market.setAttempt(result.attempt);
    if (result.existing) { setLocalError('An earlier order needs confirmation. Retry its recovery before placing another order.'); return; }
    placedAsMe.current = asMe;
    await send(result.attempt);
  });
  const checkout = async () => {
    if (sending.current || locked) return;
    if (!market.session) { navigation.current?.login('/cart'); setLocalError('Sign in before placing your order. Your cart will stay here.'); return; }
    const address = addrs.selected;
    placeTrigger.current = capturePanelFocus();
    if (!address) {
      // A failed list also reads as [] in useCheckoutAddresses, so tell "none saved" from "could not load" (#187).
      const none = addrs.addresses?.length === 0 && !addrs.error;
      if (addrs.error) { setLocalError('We couldn\'t load your addresses. Retry.'); setTimeout(() => focusAddressStep('retry'), 0); }
      else if (none) { setLocalError('Add a delivery address first.'); setTimeout(() => focusAddressStep('form'), 0); }
      else { setLocalError('Choose a delivery address first.'); addrs.open(); }
      return;
    }
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
    setRevision(null); draft.restoreRecipient(current.original.delivery);
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

    {page === 'Menu' && !demo && !market.loading && !!market.business ? <SendEvent name="menu_view" consented={market.preferences.prefs.analytics} fire={market.preferences.fireOnce} /> : null}
    {page === 'Cart' && !demo && draft.ready && cart.length > 0 ? <SendEvent name="ordering_started" consented={market.preferences.prefs.analytics} fire={market.preferences.fireOnce} /> : null}
    {page === 'Menu' && carta ? <CartaHeader name={name} {...menuProps} edge={width >= 760 ? 0 : edge} /> : null}
    {page === 'Menu' && !carta ? <View style={{ gap: 6 }}><Text accessibilityRole="header" aria-level={1} style={{ fontSize: 34, lineHeight: 42, color: colors.ink, ...(fonts.heading ? { fontFamily: fonts.heading } : { fontWeight: '700' as const }) }}>{name}</Text>{facts ? <MarketText variant="muted">{facts}</MarketText> : null}</View> : null}

    {page !== 'Menu' && page !== 'Cart' && page !== 'Help' && page !== 'Privacy' && page !== 'Terms' && page !== 'Order' && page !== 'Addresses' && page !== 'Notifications' ? <View style={{ gap: 8 }}><MarketText variant="eyebrow">{name}</MarketText><MarketText variant="title">Good food starts here.</MarketText><MarketText variant="muted">Explore the menu and find something for your table.</MarketText></View> : null}

    {!demo && (page === 'Menu' || page === 'Cart') ? <RestaurantNotice businessId={businessId} business={market.business} ready={market.businessReady} error={market.catalogError} retry={market.load} refused={refused} /> : null}
    {demo ? <MarketCard><MarketText variant="heading">Sample menu</MarketText><MarketText variant="muted">Items and prices shown as examples are for browsing only. Ordering is unavailable.</MarketText></MarketCard> : null}
    {market.notice ? <MarketText>{market.notice}</MarketText> : null}
    <RemovalAnnouncer text={removal.announcement} />
    <View role="status" accessibilityLiveRegion="polite">{leftNotice || lifecycleNote ? <MarketText>{leftNotice || lifecycleNote}</MarketText> : null}</View>
    {draft.cartError ? <MarketCard><Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={{ color: colors.danger }}>{draft.cartError}</Text><MarketButton label="Retry saved cart" variant="secondary" onPress={() => { void draft.retryCart().catch(() => {}); }} /><MarketButton label="Start new cart" variant="secondary" onPress={() => { void draft.resetCart().catch(() => {}); }} /></MarketCard> : null}
    {(market.error && (market.error !== market.catalogError || (page !== 'Menu' && page !== 'Cart'))) || market.storageError || (localError && !(page === 'Menu') && (page !== 'Cart' || !cart.length)) ? <MarketCard><Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={{ color: colors.danger, fontSize: 15, lineHeight: 23 }}>{market.storageError || localError || market.error}</Text>{market.error ? <MarketButton label="Retry loading" variant="secondary" onPress={() => void market.load()} /> : null}</MarketCard> : null}
    {market.storageError ? <MarketText>Saved checkout state is unavailable. Ordering is paused to avoid creating a duplicate order.</MarketText> : null}
    {market.attempt ? <MarketCard><MarketText variant="heading">Order awaiting confirmation</MarketText><MarketText>Your previous order may have been received. Retry the same request to recover its result before changing the cart or placing another order.</MarketText>{market.authReady && market.session?.user.id === market.attempt.userId ? market.attempt.lines.map(line => <View key={line.item.id} style={{ gap: 4 }}><MarketText>{line.quantity} × {line.item.name} · {money(line.item.pricePaise * line.quantity)}</MarketText><DietMark diet={line.item.diet} /></View>) : null}<MarketButton label={busy ? 'Checking…' : 'Retry order recovery'} disabled={busy} onPress={retry} /></MarketCard> : null}
    {quote ? <RevisedPricing quote={quote} busy={busy || !!market.attempt || !draft.ready} orderingAllowed={orderingAllowed} accept={acceptRevision} edit={editRevision} /> : null}
    {page === 'Menu' && !demo && !market.session && market.authReady ? <OfferBanner offers={offers.active} /> : null}
    {page === 'Menu' ? (market.loading ? <MarketStatus kind="loading" title="Loading menu" /> : <MenuBody variant={menuLayout} facts={facts} businessId={businessId} {...menuProps} bleed={edge} scrollRef={scrollRef} viewportListener={viewportListener} message={localError} onDismissMessage={() => setLocalError('')} undoSlot={undoBar} />) : null}
    {page === 'Cart' ? <CartPage demo={demo} cartMessage={cartMessage} ready={draft.ready} cartError={draft.cartError} cart={cart} locked={locked} orderingAllowed={orderingAllowed} hasUnavailable={unavailable}
      subtotalPaise={subtotal} deliveryFeePaise={fee} minOrderPaise={minOrder} discountPaise={billing.discountPaise} details={details} setDetails={setDetails} recipient={draft.recipient} addrs={addrs}
      placeLabel={busy ? 'Please wait…' : offers.pending ? 'Updating your offer…' : market.session && !addrs.selected ? addrs.addresses?.length === 0 && !addrs.error ? 'Add a delivery address' : 'Choose a delivery address' : 'Place order'}
      offerSlot={demo ? null : <CartOffer signedIn={signedIn} offers={offers.active} pricing={offers.quote?.pricing ?? null} nudge={offers.quote?.nudge ?? null} code={offers.code} message={offers.message} applying={offers.applying} disabled={locked || busy}
        shortfall={offers.shortfall} checkFailed={offers.checkFailed} onRetry={offers.retry} onApply={code => void offers.apply(code)} onRemove={offers.remove} onSignIn={() => navigation.current?.login('/cart')} />}
      placeDisabled={busy || locked || offers.pending || offers.checkFailed || offers.blocked || unavailable || demo || !market.business?.orderingEnabled || (!!market.session && addrs.addresses === null && !addrs.error)}
      localError={localError} undoSlot={undoBar} change={changeCart} onPlace={() => void checkout()} onBrowse={() => navigation.current?.go('/')} /> : null}
    {page === 'Account' || page === 'Login' ? <AuthPanel onLegal={path => navigation.current?.go(path)} accountActions={page === 'Account' ? <LeaveRestaurant market={market} businessId={businessId} resetCart={draft.resetCart} signOut={async () => { draft.clearForSignOut(); await market.preferences.signOut(); }} onLeft={setLeftNotice} /> : null} market={{ ...market, preferences: { ...market.preferences, signOut: async () => { draft.clearForSignOut(); await market.preferences.signOut(); } } }} /> : null}
    {page === 'Orders' ? <CustomerHistory market={market} go={path => navigation.current?.go(path)} onReorder={startReorder} /> : null}
    {page === 'Order' ? <CustomerOrderDetail market={market} id={orderId ?? ''} receipt={receipt} onReorder={startReorder} onHelp={() => navigation.current?.go(`/help?id=${orderId}`)} /> : null}
    {page === 'Help' ? <CustomerSupport businessId={businessId} market={market} go={path => navigation.current?.go(path)} orderReference={orderId} /> : null}
    {page === 'Privacy' || page === 'Terms' ? <CustomerLegal businessId={businessId} kind={page === 'Privacy' ? 'privacy' : 'terms'} go={path => navigation.current?.go(path)} /> : null}
    {page === 'Addresses' ? <CustomerAddresses market={market} /> : null}
    {page === 'Notifications' ? <CustomerNotifications market={market} go={path => navigation.current?.go(path)} /> : null}
    {page === 'Profile' ? <MarketCard><MarketText variant="heading">Edit profile</MarketText><MarketText>Profile editing is not available yet. Your account settings are available below.</MarketText><MarketButton label="Account settings" onPress={() => navigation.current?.go('/account')} /><MarketButton label="Browse menu" variant="secondary" onPress={() => navigation.current?.go('/')} /></MarketCard> : null}
  </ScrollView>;
  const sheet = confirming ? confirmationCopy(confirming.confirmation, confirming.address, confirming.totalPaise) : null;
  // Only the root Menu route waits for the first-launch welcome; deep links (/privacy, /login, orders) render normally.
  const welcomeScreen = welcome.state === 'show' ? <BrandWelcome onContinue={welcome.dismiss} /> : welcome.state === 'checking' ? <View style={{ flex: 1, backgroundColor: colors.background }} /> : null;
  return <MarketFontsProvider value={fonts}><CheckoutAddressDialogs ctrl={addrs} />{confirming && sheet ? <OrderConfirmationSheet copy={sheet} busy={busy} dismiss={() => setConfirming(null)} change={() => { setConfirming(null); addrs.open(placeTrigger.current); }} confirm={() => { const chosen = confirming; setConfirming(null);
    // The sheet quoted a total before the phone's location was awaited; never send a different one than was shown.
    try { if (validateOrder().pricing.total_paise !== chosen.totalPaise) { setLocalError('Your total changed. Please check your order and try again.'); return; } } catch (e) { setLocalError(messageOf(e)); return; }
    void submit(chosen.address, chosen.fix); }} /> : null}<CustomerNavigation signOut={async () => { draft.clearForSignOut(); await market.preferences.signOut(); }} market={market} render={render} controls={navigation} cartCount={cart.reduce((n, line) => n + line.quantity, 0)} onReorder={startReorder} reorderOpen={!!currentReorder} deliveryLine={deliveryAddressLine(demo ? null : addrs.selected)} welcome={welcomeScreen} />{currentDish ? <DishDetails key={`${market.identityVersion}-${currentDish.id}`} item={currentDish} inCart={cart.find(line => line.item.id === currentDish.id)?.quantity ?? 0} locked={locked} orderingAllowed={orderingAllowed} orderingMessage={orderingMessage} onAdd={addDetails} onClose={closeDish} /> : null}{currentReorder ? <ReorderPanel key={`${market.identityVersion}-${currentReorder.order.id}`} businessId={businessId} order={currentReorder.order} market={market} draft={draft} paused={!!quote} orderingAllowed={orderingAllowed} orderingMessage={orderingMessage} onClose={closeReorder} onSaved={message => { setReorder(null); setCartMessage(message); setLocalError(''); navigation.current?.go('/cart'); }} /> : null}</MarketFontsProvider>;
}
