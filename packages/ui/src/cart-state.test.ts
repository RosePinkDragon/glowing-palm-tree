import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addCartItem, type BusinessSlug, type MenuItem } from '@market/core';
import { cartKey, CustomerCartStore, importCart, readCart, reconcileCart, type CartStorage } from './cart-state.ts';
import { attemptKey, freezeAttempt } from './checkout-state.ts';

const business: BusinessSlug = 'ammu-sammu';
const item: MenuItem = { id: 'dish', businessId: business, name: 'Dish', description: 'Fresh', category: 'Meals', pricePaise: 10000, isAvailable: true, isDemo: false, diet: 'veg' };
const line = { item, quantity: 1 };
function memory() {
  const values = new Map<string, string>();
  return { values, async getItem(key: string) { return values.get(key) ?? null; }, async setItem(key: string, value: string) { values.set(key, value); } };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test('guest restart, login promotion and separate restaurant records retain the right cart', async () => {
  const storage = memory(); const guest = new CustomerCartStore(business, storage);
  await guest.setIdentity(null); await guest.change(() => [line]);
  const restart = new CustomerCartStore(business, storage);
  await restart.setIdentity(null); assert.deepEqual(restart.getSnapshot().lines, [line]);
  await restart.setIdentity('a'); assert.deepEqual(restart.getSnapshot().lines, [line]);
  assert.equal(readCart(await storage.getItem(cartKey(business)), business)?.ownerId, 'a');
  const other = new CustomerCartStore('kokani-dine-inn', storage);
  await other.setIdentity(null); assert.deepEqual(other.getSnapshot().lines, []);
  await other.change(() => [{ item: { ...item, businessId: 'kokani-dine-inn' }, quantity: 2 }]);
  assert.deepEqual(readCart(await storage.getItem(cartKey(business)), business)?.lines, [line]);
  const signedInRestart = new CustomerCartStore(business, storage);
  await signedInRestart.setIdentity('a'); assert.deepEqual(signedInRestart.getSnapshot().lines, [line]);
});

test('logout and direct account switches clear one active record rather than retaining account slots', async () => {
  const storage = memory(); const store = new CustomerCartStore(business, storage);
  await store.setIdentity('a'); await store.change(() => [line]);
  const exiting = store.setIdentity(null);
  assert.deepEqual(store.getSnapshot().lines, []); assert.equal(store.getSnapshot().ready, false);
  await exiting; await store.setIdentity('b'); assert.deepEqual(store.getSnapshot().lines, []);
  await store.change(() => [line]); await store.setIdentity('a'); assert.deepEqual(store.getSnapshot().lines, []);
  assert.deepEqual([...storage.values.keys()], [cartKey(business)]);
});

test('a delayed hydration cannot publish an old account after a switch or a quick A → guest → A', async () => {
  const storage = memory();
  await storage.setItem(cartKey(business), JSON.stringify({ version: 1, businessId: business, ownerId: 'a', lines: [line] }));
  const held = deferred<void>(); let first = true;
  const slow: CartStorage = { ...storage, async getItem(key) { const value = await storage.getItem(key); if (first) { first = false; await held.promise; } return value; } };
  const store = new CustomerCartStore(business, slow);
  const initial = store.setIdentity('a'); await tick();
  const out = store.setIdentity(null); const back = store.setIdentity('a');
  assert.deepEqual(store.getSnapshot().lines, []);
  held.resolve(); await Promise.all([initial, out, back]);
  assert.deepEqual(store.getSnapshot().lines, []);
  assert.deepEqual(readCart(await storage.getItem(cartKey(business)), business)?.lines, []);
});

test('delayed writes serialize behind logout, and old completion cannot repopulate B', async () => {
  const storage = memory(); const held = deferred<void>(); let hold = false;
  const slow: CartStorage = { ...storage, async setItem(key, value) { if (hold) { hold = false; await held.promise; } await storage.setItem(key, value); } };
  const store = new CustomerCartStore(business, slow); await store.setIdentity('a');
  hold = true; const saving = store.change(() => [line]); await tick();
  const out = store.setIdentity(null); const next = store.setIdentity('b');
  assert.deepEqual(store.getSnapshot().lines, []);
  held.resolve(); await Promise.all([saving, out, next]);
  assert.equal(store.getSnapshot().ownerId, 'b'); assert.deepEqual(store.getSnapshot().lines, []);
  assert.equal(readCart(await storage.getItem(cartKey(business)), business)?.ownerId, 'b');
});

test('failed logout cleanup never exposes an old owned record to guest or B, including restart', async () => {
  const storage = memory(); let fail = false;
  const failing: CartStorage = { ...storage, async setItem(key, value) { if (fail) throw new Error('Disk unavailable'); await storage.setItem(key, value); } };
  const store = new CustomerCartStore(business, failing);
  await store.setIdentity('a'); await store.change(() => [line]); fail = true;
  const out = store.setIdentity(null); assert.deepEqual(store.getSnapshot().lines, []);
  await out; assert.equal(store.getSnapshot().ready, false);
  const guest = new CustomerCartStore(business, failing); await guest.setIdentity(null);
  const other = new CustomerCartStore(business, failing); await other.setIdentity('b');
  assert.deepEqual(guest.getSnapshot().lines, []); assert.deepEqual(other.getSnapshot().lines, []);
  assert.equal(guest.getSnapshot().ready, false); assert.equal(other.getSnapshot().ready, false);
  fail = false; await store.refresh(); assert.deepEqual(store.getSnapshot().lines, []);
});

test('concurrent clients add against the latest record, refresh from storage, and reject a stale identity', async () => {
  const storage = memory(); const a = new CustomerCartStore(business, storage), b = new CustomerCartStore(business, storage);
  await a.setIdentity('a'); await b.setIdentity('a');
  await Promise.all([a.change(lines => addCartItem(lines, item)), b.change(lines => addCartItem(lines, item))]);
  await a.refresh(); assert.equal(a.getSnapshot().lines[0].quantity, 2);
  await b.setIdentity('b');
  await a.change(lines => addCartItem(lines, item));
  assert.deepEqual(a.getSnapshot().lines, []); assert.equal(a.getSnapshot().ready, false);
  assert.equal(readCart(await storage.getItem(cartKey(business)), business)?.ownerId, 'b');
  await b.change(() => [line]); await a.reset();
  assert.deepEqual(readCart(await storage.getItem(cartKey(business)), business)?.lines, [line]);
});

test('a batched return to the same account still clears a previous identity generation', async () => {
  const storage = memory(); const store = new CustomerCartStore(business, storage);
  await store.setIdentity('a', 1); await store.change(() => [line]);
  await store.setIdentity('a', 3);
  assert.deepEqual(store.getSnapshot().lines, []);
});

test('malformed, oversized, duplicate, cross-business and out-of-range carts fail closed; reset is isolated', async () => {
  const record = { version: 1, businessId: business, ownerId: null, lines: [line] };
  for (const value of ['{broken', 'null', JSON.stringify({ ...record, version: 0 }), JSON.stringify({ ...record, ownerId: undefined }), JSON.stringify({ ...record, lines: [line, line] }), JSON.stringify({ ...record, lines: [{ ...line, quantity: 11 }] }), JSON.stringify({ ...record, lines: [{ item: { ...item, pricePaise: -1 }, quantity: 1 }] }), JSON.stringify({ ...record, lines: [{ item: { ...item, businessId: 'kokani-dine-inn' }, quantity: 1 }] }), ' '.repeat(120001)]) {
    assert.throws(() => readCart(value, business));
  }
  const storage = memory(); storage.values.set(cartKey(business), '{broken');
  storage.values.set(attemptKey(business), 'untouched uncertain request');
  const store = new CustomerCartStore(business, storage); await store.setIdentity(null);
  assert.equal(store.getSnapshot().ready, false); assert.ok(store.getSnapshot().error);
  await store.reset(); assert.equal(store.getSnapshot().ready, true); assert.deepEqual(store.getSnapshot().lines, []);
  assert.equal(storage.values.get(attemptKey(business)), 'untouched uncertain request');
});

test('failed saves retain the last persisted cart and permit retry without accepting a lost update', async () => {
  const storage = memory(); let fail = false;
  const failing: CartStorage = { ...storage, async setItem(key, value) { if (fail) throw new Error('quota'); await storage.setItem(key, value); } };
  const store = new CustomerCartStore(business, failing); await store.setIdentity(null); await store.change(() => [line]);
  fail = true; await assert.rejects(store.change(() => []), /quota/);
  assert.deepEqual(store.getSnapshot().lines, [line]); assert.ok(store.getSnapshot().error);
  fail = false; await store.refresh(); await store.change(() => []);
  assert.deepEqual(store.getSnapshot().lines, []); assert.equal(store.getSnapshot().error, '');
});

test('reconciliation refreshes all catalog metadata, marks missing dishes and leaves uncertain snapshots immutable', () => {
  const attempt = freezeAttempt({ businessId: business, userId: 'a', idempotencyKey: 'uncertain', lines: [line], delivery: { name: 'Private', phone: '1', addressLine: 'Private address' }, location: { latitude: 1, longitude: 2, accuracy: 3, capturedAtISO: '2026-11-14T00:00:00Z' } });
  const before = JSON.stringify(attempt);
  const updated = { ...item, name: 'New dish name', description: 'New description', diet: 'egg' as const, pricePaise: 15000, isAvailable: false, imageUrl: 'https://image.test/dish.jpg' };
  const cart = reconcileCart(attempt.lines, [updated], business);
  assert.deepEqual(cart[0].item, updated); assert.equal(cart[0].quantity, 1);
  const removed = reconcileCart(attempt.lines, [], business);
  assert.equal(removed[0].item.isAvailable, false); assert.equal(removed[0].item.name, 'Dish');
  assert.equal(cart[0].item.diet, 'egg');
  assert.equal(attempt.lines[0].item.diet, 'veg');
  assert.equal(JSON.stringify(attempt), before);
});

test('import requires explicit add or replace and applies quantity/business limits atomically', () => {
  assert.equal(importCart([line], [line], 'add', business)[0].quantity, 2);
  assert.equal(importCart([line], [line], 'replace', business)[0].quantity, 1);
  assert.throws(() => importCart([line], [line], undefined as never, business), /Choose/);
  assert.throws(() => importCart([{ ...line, quantity: 10 }], [line], 'add', business));
  assert.throws(() => importCart([line], [{ item: { ...item, businessId: 'kokani-dine-inn' }, quantity: 1 }], 'replace', business));
  assert.equal(line.quantity, 1);
});


test('a rejected browser lock fails closed and can be retried without an unhandled initialization', async () => {
  const storage = memory(); let fail = true;
  const store = new CustomerCartStore(business, storage, async (_key, work) => { if (fail) throw new Error('Lock denied'); return work(); });
  await assert.rejects(store.setIdentity(null), /Lock denied/);
  assert.equal(store.getSnapshot().ready, false); assert.ok(store.getSnapshot().error);
  fail = false; await store.refresh(); await store.change(() => [line]);
  assert.deepEqual(store.getSnapshot().lines, [line]);
});

test('a second same-window action cannot unlock checkout while its first write is pending', async () => {
  const storage = memory(); const held = deferred<void>(); let hold = false;
  const slow: CartStorage = { ...storage, async setItem(key, value) { if (hold) { hold = false; await held.promise; } await storage.setItem(key, value); } };
  const store = new CustomerCartStore(business, slow); await store.setIdentity(null);
  hold = true; const saving = store.change(lines => addCartItem(lines, item)); await tick();
  await assert.rejects(store.change(lines => addCartItem(lines, item)), /finish saving/);
  assert.equal(store.getSnapshot().saving, true);
  held.resolve(); await saving;
  assert.equal(store.getSnapshot().saving, false); assert.equal(store.getSnapshot().lines[0].quantity, 1);
});

test('an earlier slow cross-tab refresh cannot clear the saving marker of an admitted change', async () => {
  const storage = memory(); const read = deferred<void>(), write = deferred<void>(); let holdRead = false, holdWrite = false;
  const slow: CartStorage = {
    async getItem(key) { const value = await storage.getItem(key); if (holdRead) { holdRead = false; await read.promise; } return value; },
    async setItem(key, value) { if (holdWrite) { holdWrite = false; await write.promise; } await storage.setItem(key, value); },
  };
  const store = new CustomerCartStore(business, slow); await store.setIdentity(null);
  holdRead = true; const refreshing = store.refresh(); await tick();
  holdWrite = true; const saving = store.change(lines => addCartItem(lines, item));
  read.resolve(); await tick();
  assert.equal(store.getSnapshot().saving, true);
  await assert.rejects(store.change(lines => addCartItem(lines, item)), /finish saving/);
  write.resolve(); await Promise.all([refreshing, saving]);
  assert.equal(store.getSnapshot().saving, false); assert.equal(store.getSnapshot().lines[0].quantity, 1);
});
