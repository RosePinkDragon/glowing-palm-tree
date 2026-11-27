import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { BusinessSlug, CartLine, MenuItem, Order } from '@market/core';
import { cartKey, CartReviewRequiredError, CustomerCartStore, importCart, reconcileCart, type CartLock } from './cart-state';
import { activeContact, chooseMode, editActive, emptyContact, emptyRecipient, ownNameKey, planOwnName, prefillOwn, restoreDelivery, type Contact, type ProfileRead, type RecipientMode, type RecipientState } from './recipient-model';

const noProfile: ProfileRead = { status: 'idle', name: null };
/** The old device-only own name. Storage can be blocked or full: reading gives null and removing is skipped, neither ever fails checkout. */
const readDeviceName = async (userId: string) => { try { return await AsyncStorage.getItem(ownNameKey(userId)); } catch { return null; } };
const removeDeviceName = async (userId: string) => { try { await AsyncStorage.removeItem(ownNameKey(userId)); } catch { /* it is only a leftover; the next checkout tries again */ } };

/** The draft has its own key and lifecycle; submitted checkout snapshots are separate. */
/** `prefill` is off on the demo menu, which must not read or store anyone's contact details (#187). */
export function useCustomerCart(businessId: BusinessSlug, userId: string | null, authReady: boolean, identityVersion: number, menu: MenuItem[], catalogReady: boolean, prefill: { enabled: boolean; phone: string | null | undefined; profile?: ProfileRead } = { enabled: false, phone: null }) {
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
  // Who the order is for and their details (#187). `live` is the latest state, so a late async prefill reads what was just typed.
  const [recipient, setRecipientState] = useState<RecipientState>(emptyRecipient), live = useRef<RecipientState>(emptyRecipient), prefillRun = useRef(0);
  live.current = recipient;
  const update = useCallback((change: (state: RecipientState) => RecipientState) => { const next = change(live.current); live.current = next; setRecipientState(next); }, []);
  const setDetails = useCallback((next: Contact) => update(state => editActive(state, next)), [update]);
  const setMode = useCallback((mode: RecipientMode) => update(state => chooseMode(state, mode)), [update]);
  const restoreRecipient = useCallback((delivery: Contact) => update(state => restoreDelivery(state, delivery)), [update]);
  const clearDetails = () => { prefillRun.current++; live.current = emptyRecipient; setRecipientState(emptyRecipient); };
  const [receiptState, setReceiptState] = useState<{ userId: string | null; order: Order | null }>({ userId, order: null });
  const setReceipt = (order: Order | null) => setReceiptState({ userId, order });

  useEffect(() => { if (authReady) void store.setIdentity(userId, identityVersion).catch(() => {}); }, [store, userId, authReady, identityVersion]);
  useEffect(() => {
    if (previousIdentity.current.userId !== null && (previousIdentity.current.userId !== userId || previousIdentity.current.identityVersion !== identityVersion)) {
      setReceiptState({ userId, order: null }); clearDetails();
    }
    previousIdentity.current = { userId, identityVersion };
  }, [userId, identityVersion]);
  // Fill the account holder's own Mobile (the verified login number) and Name (the shared profile, #45) without ever overwriting typing:
  // prefillOwn only touches fields the customer has not edited, so a profile that loads late or refreshes never replaces a manual change.
  // A name kept on this device by an older version is used only once the profile has confirmed it has none (see planOwnName).
  const sessionPhone = prefill.phone, read = prefill.profile ?? noProfile, readStatus = read.status, readName = read.name;
  useEffect(() => {
    const run = ++prefillRun.current;
    if (!prefill.enabled || !authReady || !userId) return;
    const confirmed: ProfileRead = { status: readStatus, name: readName };
    update(state => prefillOwn(state, planOwnName(confirmed, null).prefill, sessionPhone));
    if (readStatus !== 'ready') return;
    void readDeviceName(userId).then(raw => {
      if (prefillRun.current !== run || currentIdentity.current.userId !== userId || currentIdentity.current.identityVersion !== identityVersion) return;
      const plan = planOwnName(confirmed, raw);
      if (plan.prefill) update(state => prefillOwn(state, plan.prefill, sessionPhone));
      if (plan.removeKey) void removeDeviceName(userId);
    });
  }, [userId, authReady, identityVersion, prefill.enabled, sessionPhone, readStatus, readName, update]);
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
    setReceiptState({ userId: null, order: null }); clearDetails();
    // Do not hold signing out hostage to storage or a lock in another window.
    void store.reset().catch(() => {});
  };
  /** The profile now holds the name, so the old device copy is finished with. Never throws. */
  const forgetDeviceName = (forUser: string) => prefill.enabled ? removeDeviceName(forUser) : Promise.resolve();
  return {
    cart, menu: activeMenu, setCart, changeCart, importLines, ready, saving: snapshot.saving, cartError: snapshot.error,
    retryCart: store.refresh, resetCart: store.reset, clearForSignOut, forgetDeviceName,
    details: leavingIdentity ? emptyContact : activeContact(recipient), setDetails,
    recipient: leavingIdentity ? { ...emptyRecipient, setMode, own: emptyContact } : { ...recipient, setMode }, restoreRecipient,
    receipt: userId && receiptState.userId === userId ? receiptState.order : null, setReceipt,
  };
}
