import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { BusinessSlug, CartLine, DeliveryDetails, LocationFix, MenuItem, Order } from '@market/core';
import { cartKey, CustomerCartStore, importCart, reconcileCart, type CartLock } from './cart-state';

const emptyDetails = { name: '', phone: '', addressLine: '' };

/** The draft has its own key and lifecycle; submitted checkout snapshots are separate. */
export function useCustomerCart(businessId: BusinessSlug, userId: string | null, authReady: boolean, identityVersion: number, menu: MenuItem[], catalogReady: boolean) {
  const store = useMemo(() => {
    const lock: CartLock | undefined = Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.locks
      ? (key, work) => navigator.locks.request(key, work) : undefined;
    return new CustomerCartStore(businessId, AsyncStorage, lock);
  }, [businessId]);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const previousIdentity = useRef({ userId, identityVersion });
  const leavingIdentity = previousIdentity.current.userId !== null && (previousIdentity.current.userId !== userId || previousIdentity.current.identityVersion !== identityVersion);
  const [details, setDetails] = useState<DeliveryDetails>(emptyDetails);
  const [location, setLocation] = useState<LocationFix | null>(null);
  const [eligible, setEligible] = useState(false);
  const [receiptState, setReceiptState] = useState<{ userId: string | null; order: Order | null }>({ userId, order: null });
  const setReceipt = (order: Order | null) => setReceiptState({ userId, order });

  useEffect(() => { if (authReady) void store.setIdentity(userId, identityVersion).catch(() => {}); }, [store, userId, authReady, identityVersion]);
  useEffect(() => {
    if (previousIdentity.current.userId !== null && (previousIdentity.current.userId !== userId || previousIdentity.current.identityVersion !== identityVersion)) {
      setReceiptState({ userId, order: null }); setDetails(emptyDetails); setLocation(null); setEligible(false);
    }
    previousIdentity.current = { userId, identityVersion };
  }, [userId, identityVersion]);
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;
    const onStorage = (event: StorageEvent) => { if (event.key === null || event.key === cartKey(businessId)) void store.refresh().catch(() => {}); };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [store, businessId]);

  const ready = authReady && catalogReady && !leavingIdentity && snapshot.ready && snapshot.ownerId === userId;
  const cart = useMemo(() => ready ? reconcileCart(snapshot.lines, menu, businessId) : [], [ready, snapshot.lines, menu, businessId]);
  const reconciled = useRef<{ store: CustomerCartStore; menu: MenuItem[] } | null>(null);
  useEffect(() => {
    if (ready && !snapshot.saving && !snapshot.error && (reconciled.current?.store !== store || reconciled.current.menu !== menu)) {
      // Reconcile once per loaded catalog, not on every other tab's storage event:
      // an older tab must not continually write its cached menu over a newer tab.
      reconciled.current = { store, menu };
      if (JSON.stringify(cart) === JSON.stringify(snapshot.lines)) return;
      void store.change(lines => reconcileCart(lines, menu, businessId)).catch(() => {});
    }
  }, [ready, snapshot, cart, menu, businessId, store]);

  const changeCart = useCallback((update: (lines: CartLine[]) => CartLine[]) => {
    if (!authReady || !catalogReady || snapshot.ownerId !== userId) return Promise.reject(new Error('Wait for your cart and menu to load.'));
    return store.change(lines => update(reconcileCart(lines, menu, businessId)));
  }, [store, menu, businessId, authReady, catalogReady, snapshot.ownerId, userId]);
  const setCart = useCallback((lines: CartLine[]) => changeCart(() => lines), [changeCart]);
  const importLines = useCallback((lines: CartLine[], mode: 'add' | 'replace') => changeCart(current => reconcileCart(importCart(current, lines, mode, businessId), menu, businessId)), [changeCart, menu, businessId]);
  const clearForSignOut = () => {
    setReceiptState({ userId: null, order: null }); setDetails(emptyDetails); setLocation(null); setEligible(false);
    // Do not hold signing out hostage to storage or a lock in another window.
    void store.reset().catch(() => {});
  };
  return {
    cart, setCart, changeCart, importLines, ready, saving: snapshot.saving, cartError: snapshot.error,
    retryCart: store.refresh, resetCart: store.reset, clearForSignOut,
    details: leavingIdentity ? emptyDetails : details, setDetails,
    location: leavingIdentity ? null : location, setLocation, eligible: !leavingIdentity && eligible, setEligible,
    receipt: userId && receiptState.userId === userId ? receiptState.order : null, setReceipt,
  };
}
