import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { BusinessSlug, CartLine, MenuItem, Order } from '@market/core';
import { cartKey, CartReviewRequiredError, CustomerCartStore, importCart, reconcileCart, type CartLock } from './cart-state';

const emptyDetails = { name: '', phone: '' };

/** The draft has its own key and lifecycle; submitted checkout snapshots are separate. */
export function useCustomerCart(businessId: BusinessSlug, userId: string | null, authReady: boolean, identityVersion: number, menu: MenuItem[], catalogReady: boolean) {
  const store = useMemo(() => {
    const lock: CartLock | undefined = Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.locks
      ? (key, work) => navigator.locks.request(key, work) : undefined;
    return new CustomerCartStore(businessId, AsyncStorage, lock);
  }, [businessId]);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const currentIdentity = useRef({ userId, identityVersion, authReady });
  currentIdentity.current = { userId, identityVersion, authReady };
  const [freshCatalog, setFreshCatalog] = useState<{ base: MenuItem[]; menu: MenuItem[]; identityVersion: number; userId: string | null } | null>(null);
  // Adopt the menu used for a persisted reorder until the ordinary catalog is reloaded.
  // Reading or cancelling a reorder must not reconcile an existing draft as a side effect.
  const activeMenu = freshCatalog?.base === menu && freshCatalog.identityVersion === identityVersion && freshCatalog.userId === userId ? freshCatalog.menu : menu;
  const previousIdentity = useRef({ userId, identityVersion });
  const leavingIdentity = previousIdentity.current.userId !== null && (previousIdentity.current.userId !== userId || previousIdentity.current.identityVersion !== identityVersion);
  const [details, setDetails] = useState<{ name: string; phone: string }>(emptyDetails);
  const [receiptState, setReceiptState] = useState<{ userId: string | null; order: Order | null }>({ userId, order: null });
  const setReceipt = (order: Order | null) => setReceiptState({ userId, order });

  useEffect(() => { if (authReady) void store.setIdentity(userId, identityVersion).catch(() => {}); }, [store, userId, authReady, identityVersion]);
  useEffect(() => {
    if (previousIdentity.current.userId !== null && (previousIdentity.current.userId !== userId || previousIdentity.current.identityVersion !== identityVersion)) {
      setReceiptState({ userId, order: null }); setDetails(emptyDetails);
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
  const cart = useMemo(() => ready ? reconcileCart(snapshot.lines, activeMenu, businessId) : [], [ready, snapshot.lines, activeMenu, businessId]);
  const reconciled = useRef<{ store: CustomerCartStore; menu: MenuItem[] } | null>(null);
  useEffect(() => {
    if (ready && !snapshot.saving && !snapshot.error && (reconciled.current?.store !== store || reconciled.current.menu !== activeMenu)) {
      // Reconcile once per loaded catalog, not on every other tab's storage event:
      // an older tab must not continually write its cached menu over a newer tab.
      reconciled.current = { store, menu: activeMenu };
      if (JSON.stringify(cart) === JSON.stringify(snapshot.lines)) return;
      void store.change(lines => reconcileCart(lines, activeMenu, businessId)).catch(() => {});
    }
  }, [ready, snapshot, cart, activeMenu, businessId, store]);

  const changeCart = useCallback((update: (lines: CartLine[]) => CartLine[]) => {
    if (!authReady || !catalogReady || snapshot.ownerId !== userId) return Promise.reject(new Error('Wait for your cart and menu to load.'));
    return store.change(lines => update(reconcileCart(lines, activeMenu, businessId)));
  }, [store, activeMenu, businessId, authReady, catalogReady, snapshot.ownerId, userId]);
  const setCart = useCallback((lines: CartLine[]) => changeCart(() => lines), [changeCart]);
  const importLines = useCallback(async (lines: CartLine[], mode: 'add' | 'replace', options: { menu: MenuItem[]; expectedRevision: number; onlyIfEmpty?: boolean; validate: () => void }) => {
    const started = currentIdentity.current;
    const validate = () => {
      const now = currentIdentity.current;
      if (!now.authReady || now.userId !== started.userId || now.identityVersion !== started.identityVersion || !started.userId) throw new Error('Your account changed. Nothing was added by this reorder.');
      options.validate();
    };
    validate();
    const applied = await store.change(current => {
      validate();
      if (options.onlyIfEmpty && current.length) throw new CartReviewRequiredError();
      return importCart(reconcileCart(current, options.menu, businessId), lines, mode, businessId);
    }, options.expectedRevision);
    validate();
    if (!applied) throw new Error('Your cart or account changed. Review it before reordering.');
    setFreshCatalog({ base: menu, menu: options.menu, identityVersion: started.identityVersion, userId: started.userId });
  }, [store, menu, businessId]);
  const clearForSignOut = () => {
    setReceiptState({ userId: null, order: null }); setDetails(emptyDetails);
    // Do not hold signing out hostage to storage or a lock in another window.
    void store.reset().catch(() => {});
  };
  return {
    cart, menu: activeMenu, setCart, changeCart, importLines, ready, saving: snapshot.saving, cartError: snapshot.error,
    retryCart: store.refresh, resetCart: store.reset, clearForSignOut,
    details: leavingIdentity ? emptyDetails : details, setDetails,
    receipt: userId && receiptState.userId === userId ? receiptState.order : null, setReceipt,
  };
}
