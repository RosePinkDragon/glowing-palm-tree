import { addCartItem, type BusinessSlug, type CartLine, type MenuItem } from '@market/core';

export interface SavedCart {
  version: 1;
  revision: number;
  businessId: BusinessSlug;
  ownerId: string | null;
  lines: CartLine[];
}
export interface CartStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}
export interface CartSnapshot {
  ownerId: string | null;
  lines: CartLine[];
  ready: boolean;
  saving: boolean;
  error: string;
}
export type CartLock = <T>(name: string, work: () => Promise<T>) => Promise<T>;
const queues = new Map<string, Promise<unknown>>();

export function cartKey(businessId: BusinessSlug) { return `market:cart:${businessId}`; }

function validLines(value: unknown, businessId: BusinessSlug): value is CartLine[] {
  if (!Array.isArray(value) || value.length > 20) return false;
  const ids = new Set<string>();
  return value.every(line => {
    const item = line?.item;
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !item.id || item.id.length > 128 || ids.has(item.id) ||
        item.businessId !== businessId || typeof item.name !== 'string' || !item.name || item.name.length > 100 ||
        typeof item.description !== 'string' || item.description.length > 1000 || typeof item.category !== 'string' || item.category.length > 100 ||
        !Number.isSafeInteger(item.pricePaise) || item.pricePaise < 0 || item.pricePaise > 2147483647 ||
        typeof item.isAvailable !== 'boolean' || typeof item.isDemo !== 'boolean' ||
        (item.imageUrl !== undefined && (typeof item.imageUrl !== 'string' || item.imageUrl.length > 4096)) ||
        !Number.isSafeInteger(line.quantity) || line.quantity < 1 || line.quantity > 10) return false;
    ids.add(item.id); return true;
  });
}

export function readCart(value: string | null, businessId: BusinessSlug): SavedCart | null {
  if (value === null) return null;
  if (value.length > 120000) throw new Error('Invalid saved cart');
  const cart = JSON.parse(value) as SavedCart | null;
  if (!cart || cart.version !== 1 || !Number.isSafeInteger(cart.revision) || cart.revision < 1 || cart.businessId !== businessId ||
      !(cart.ownerId === null || (typeof cart.ownerId === 'string' && cart.ownerId.length > 0 && cart.ownerId.length <= 128)) ||
      !validLines(cart.lines, businessId)) throw new Error('Invalid saved cart');
  return { version: 1, revision: cart.revision, businessId, ownerId: cart.ownerId, lines: cart.lines };
}

/** Missing dishes stay visible for explicit removal; snapshots are never mutated. */
export function reconcileCart(lines: readonly CartLine[], menu: readonly MenuItem[], businessId: BusinessSlug): CartLine[] {
  const current = new Map(menu.filter(item => item.businessId === businessId).map(item => [item.id, item]));
  return lines.map(line => ({ quantity: line.quantity, item: current.get(line.item.id) ?? { ...line.item, isAvailable: false } }));
}

/** Importing a future reorder must always choose add or replace explicitly. */
export function importCart(current: readonly CartLine[], incoming: readonly CartLine[], mode: 'add' | 'replace', businessId: BusinessSlug): CartLine[] {
  if (mode !== 'add' && mode !== 'replace') throw new Error('Choose whether to add to or replace the cart.');
  if (!validLines(incoming, businessId)) throw new Error('These dishes could not be added to this restaurant’s cart.');
  if (mode === 'replace') return incoming.map(line => ({ ...line, item: { ...line.item } }));
  return incoming.reduce((lines, line) => addCartItem(lines, line.item, line.quantity), [...current]);
}

/** One active record per business. Every mutation reads the latest record under a lock. */
export class CustomerCartStore {
  private owner: string | null | undefined;
  private identityEpoch: number | undefined;
  private generation = 0;
  private clearRequired = false;
  private pendingChanges = 0;
  private listeners = new Set<() => void>();
  private state: CartSnapshot = { ownerId: null, lines: [], ready: false, saving: false, error: '' };
  private businessId: BusinessSlug;
  private storage: CartStorage;
  private lock?: CartLock;
  constructor(businessId: BusinessSlug, storage: CartStorage, lock?: CartLock) { this.businessId = businessId; this.storage = storage; this.lock = lock; }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(state: CartSnapshot) { this.state = { ...state, saving: state.saving || this.pendingChanges > 0 }; for (const listener of this.listeners) listener(); }
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const key = cartKey(this.businessId);
    const generation = this.generation;
    const next = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
      let entered = false;
      const run = () => { entered = true; return work(); };
      try { return this.lock ? await this.lock(key, run) : await run(); }
      catch (error) {
        if (!entered && generation === this.generation) this.publish({ ...this.state, ready: false, saving: false, error: 'We couldn’t access your saved cart. Retry or start a new cart.' });
        throw error;
      }
    });
    queues.set(key, next);
    void next.finally(() => { if (queues.get(key) === next) queues.delete(key); }).catch(() => {});
    return next;
  }
  private async write(ownerId: string | null, lines: CartLine[]) {
    // Every caller holds the cart lock. A revision distinguishes a fulfilled cart
    // from a later cart with exactly the same dishes and quantities.
    let previous: SavedCart | null = null;
    try { previous = readCart(await this.storage.getItem(cartKey(this.businessId)), this.businessId); } catch { /* Explicit recovery can replace a corrupt record. */ }
    const revision = (previous?.revision ?? 0) + 1;
    if (!Number.isSafeInteger(revision)) throw new Error('The saved cart revision is invalid.');
    const record: SavedCart = { version: 1, revision, businessId: this.businessId, ownerId, lines };
    return this.storage.setItem(cartKey(this.businessId), JSON.stringify(record));
  }

  setIdentity(ownerId: string | null, identityEpoch?: number) {
    if (this.owner === ownerId && this.identityEpoch === identityEpoch) return Promise.resolve();
    if (this.owner !== undefined && this.owner !== null) this.clearRequired = true;
    this.owner = ownerId;
    this.identityEpoch = identityEpoch;
    const generation = ++this.generation;
    this.publish({ ownerId, lines: [], ready: false, saving: false, error: '' });
    return this.exclusive(async () => {
      if (generation !== this.generation) return;
      try {
        // A logout/account switch wins over any queued read, including A → guest → A.
        const saved = this.clearRequired ? null : readCart(await this.storage.getItem(cartKey(this.businessId)), this.businessId);
        if (generation !== this.generation) return;
        const lines = saved && (saved.ownerId === ownerId || saved.ownerId === null) ? saved.lines : [];
        await this.write(ownerId, lines);
        if (generation !== this.generation) return;
        this.clearRequired = false;
        this.publish({ ownerId, lines, ready: true, saving: false, error: '' });
      } catch {
        if (generation === this.generation) this.publish({ ownerId, lines: [], ready: false, saving: false, error: 'We couldn’t restore your saved cart. Retry or start a new cart.' });
      }
    });
  }

  /** Storage events are hints: re-read under the lock, never apply an old event payload. */
  refresh = () => {
    const generation = this.generation, ownerId = this.owner;
    if (ownerId === undefined) return Promise.resolve();
    return this.exclusive(async () => {
      if (generation !== this.generation) return;
      try {
        if (this.clearRequired) {
          await this.write(ownerId, []);
          if (generation !== this.generation) return;
          this.clearRequired = false;
          this.publish({ ownerId, lines: [], ready: true, saving: false, error: '' });
          return;
        }
        const saved = readCart(await this.storage.getItem(cartKey(this.businessId)), this.businessId);
        if (generation !== this.generation) return;
        if (saved && saved.ownerId !== ownerId) {
          this.publish({ ownerId, lines: [], ready: false, saving: false, error: 'Your account changed in another window. Refresh this page before changing the cart.' });
          return;
        }
        this.publish({ ownerId, lines: saved?.lines ?? [], ready: true, saving: false, error: '' });
      } catch {
        if (generation === this.generation) this.publish({ ...this.state, ready: false, saving: false, error: 'We couldn’t restore your saved cart. Retry or start a new cart.' });
      }
    });
  };

  change = (update: (lines: CartLine[]) => CartLine[]) => {
    const generation = this.generation, ownerId = this.owner;
    if (ownerId === undefined || !this.state.ready || this.state.error) return Promise.reject(new Error('Wait for your saved cart to load.'));
    if (this.state.saving) return Promise.reject(new Error('Wait for your cart to finish saving.'));
    this.pendingChanges++;
    this.publish({ ...this.state, saving: true });
    return this.exclusive(async () => {
      if (generation !== this.generation) return;
      try {
        const saved = readCart(await this.storage.getItem(cartKey(this.businessId)), this.businessId);
        if (generation !== this.generation) return;
        if (saved && saved.ownerId !== ownerId) {
          this.publish({ ownerId, lines: [], ready: false, saving: false, error: 'Your account changed in another window. Refresh this page before changing the cart.' });
          return;
        }
        let lines: CartLine[];
        try {
          lines = update(saved?.lines ?? []);
          if (!validLines(lines, this.businessId)) throw new Error('These dishes could not be saved to the cart.');
        } catch (error) {
          this.publish({ ...this.state, saving: false });
          return Promise.reject(error);
        }
        await this.write(ownerId, lines);
        if (generation === this.generation) this.publish({ ownerId, lines, ready: true, saving: false, error: '' });
      } catch (error) {
        if (generation === this.generation) this.publish({ ...this.state, saving: false, error: 'We couldn’t save your cart. Retry before making more changes.' });
        throw error;
      }
    }).finally(() => {
      this.pendingChanges--;
      if (generation === this.generation) this.publish({ ...this.state, saving: false });
    });
  };

  /** Reset only the draft record; never read, remove or replace checkout-attempt storage. */
  reset = () => {
    const ownerId = this.owner;
    if (ownerId === undefined) return Promise.reject(new Error('Wait for your account to load.'));
    const generation = ++this.generation;
    this.publish({ ownerId, lines: [], ready: false, saving: true, error: '' });
    return this.exclusive(async () => {
      if (generation !== this.generation) return;
      try {
        const value = await this.storage.getItem(cartKey(this.businessId));
        let saved: SavedCart | null = null;
        try { saved = readCart(value, this.businessId); } catch { /* Explicit reset may replace a corrupt draft. */ }
        if (generation !== this.generation) return;
        if (saved && saved.ownerId !== ownerId) {
          this.publish({ ownerId, lines: [], ready: false, saving: false, error: 'Your account changed in another window. Refresh this page before changing the cart.' });
          return;
        }
        await this.write(ownerId, []);
        if (generation !== this.generation) return;
        this.clearRequired = false;
        this.publish({ ownerId, lines: [], ready: true, saving: false, error: '' });
      } catch (error) {
        if (generation === this.generation) this.publish({ ownerId, lines: [], ready: false, saving: false, error: 'We couldn’t clear your saved cart. Retry before signing out or making more changes.' });
        throw error;
      }
    });
  };
}
