import { webRedirectUrl } from './auth-callback.ts';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { freezeAttempt, readAttempt } from './checkout-state.ts';

test('a persisted attempt preserves the original request for retries', () => {
  const source = { businessId: 'ammu-sammu' as const, userId: 'user', idempotencyKey: 'key', lines: [{ item: { id: 'dish', businessId: 'ammu-sammu' as const, name: 'Dish', description: '', category: 'Food', pricePaise: 100, isAvailable: true, isDemo: false }, quantity: 1 }], delivery: { name: 'Name', phone: '123', addressLine: 'Address' }, location: { latitude: 1, longitude: 2, accuracy: 3, capturedAtISO: '2026-01-01T00:00:00Z' } };
  const snapshot = freezeAttempt(source);
  source.lines[0].quantity = 2; source.delivery.name = 'Changed';
  const restored = readAttempt(JSON.stringify(snapshot), 'ammu-sammu');
  assert.equal(restored?.lines[0].quantity, 1);
  assert.equal(restored?.delivery.name, 'Name');
  assert.equal(restored?.idempotencyKey, 'key');
  assert.throws(() => readAttempt(JSON.stringify(snapshot), 'kokani-dine-inn'));
});

test('only a definite RPC rejection can release an attempt', async () => {
  const { isDefiniteOrderRejection } = await import('./checkout-state.ts');
  const error = (message: string, code: string) => Object.assign(new Error(message), { code });
  assert.equal(isDefiniteOrderRejection(error('Could not place order: delivery unavailable', '22023')), true);
  assert.equal(isDefiniteOrderRejection(error('Could not place order: idempotency key reused with different request', '22023')), false);
  assert.equal(isDefiniteOrderRejection(error('Order was saved, but its details could not be loaded', '22023')), false);
  assert.equal(isDefiniteOrderRejection(error('Could not place order: business unavailable', '22023')), false);
  assert.equal(isDefiniteOrderRejection(error('Could not place order: authentication and idempotency key required', '22023')), false);
  assert.equal(isDefiniteOrderRejection(new Error('Network timeout')), false);
});

test('responses from a previous identity cannot be accepted after account changes', async () => {
  const { nextIdentity, sameIdentity } = await import('./checkout-state.ts');
  const initial = { userId: 'a', generation: 1 };
  const switched = nextIdentity(initial, 'b');
  assert.equal(sameIdentity(initial, switched), false);
  const returned = nextIdentity(switched, 'a');
  assert.equal(sameIdentity(initial, returned), false);
  assert.equal(sameIdentity(returned, nextIdentity(returned, 'a')), true);
});

test('delayed order results are discarded after logout and after returning to the same account', async () => {
  const { nextIdentity, sameIdentity } = await import('./checkout-state.ts');
  let current = { userId: 'a' as string | null, generation: 1 };
  const started = current;
  let resolve!: (value: string) => void;
  const response = new Promise<string>(done => { resolve = done; });
  let visible = '';
  const pending = response.then(value => { if (sameIdentity(started, current)) visible = value; });
  current = nextIdentity(current, null);
  current = nextIdentity(current, 'a');
  resolve('private order');
  await pending;
  assert.equal(visible, '');
});

test('auth callback keeps deployed app path and removes credentials even on errors', async () => {
  const { parseAuthCallback, webRedirectUrl } = await import('./auth-callback.ts');
  const href = 'https://example.test/glowing-palm-tree/app/?code=secret&keep=yes#error_description=expired&access_token=foreign';
  assert.equal(webRedirectUrl(href), 'https://example.test/glowing-palm-tree/app/');
  const callback = parseAuthCallback(href);
  assert.equal(callback.code, 'secret');
  assert.equal(callback.error, 'expired');
  assert.equal(callback.cleanUrl, '/glowing-palm-tree/app/?keep=yes');
  const tokenOnly = parseAuthCallback('https://example.test/app/#access_token=foreign&refresh_token=foreign');
  assert.equal(tokenOnly.code, null);
  assert.equal(tokenOnly.cleanUrl, '/app/');
  assert.equal(parseAuthCallback('https://example.test/app/?type=food#menu').hasAuth, false);
  assert.equal(parseAuthCallback('https://example.test/app/?type=food#menu').cleanUrl, '/app/?type=food#menu');
});

test('two checkout clients cannot replace an uncertain persisted attempt', async () => {
  const { withCheckoutGuard, prepareAttempt } = await import('./checkout-guard.ts');
  let held = false; let stored: string | null = null; let created = 0; const sent: string[] = [];
  const locks = { async request<T>(_name: string, _options: { ifAvailable: true }, callback: (lock: object | null) => Promise<T>): Promise<T> { if (held) return callback(null); held = true; try { return await callback({}); } finally { held = false; } } };
  const storage = { async getItem() { return stored; }, async setItem(_key: string, value: string) { stored = value; } };
  const create = () => freezeAttempt({ businessId: 'ammu-sammu', userId: 'a', idempotencyKey: `key-${++created}`, lines: [], delivery: { name: 'A', phone: '1', addressLine: 'Address' }, location: { latitude: 1, longitude: 2, accuracy: 3, capturedAtISO: '2026-01-01T00:00:00Z' } });
  let release!: () => void; const network = new Promise<void>(resolve => { release = resolve; });
  const first = withCheckoutGuard('ammu-sammu', true, async () => { const result = await prepareAttempt(storage, 'ammu-sammu', create); sent.push(result.attempt.idempotencyKey); await network; throw new Error('response lost'); }, locks);
  await new Promise<void>(resolve => setImmediate(resolve));
  await assert.rejects(withCheckoutGuard('ammu-sammu', true, async () => { await prepareAttempt(storage, 'ammu-sammu', create); }, locks), /Another window/);
  release(); await assert.rejects(first, /response lost/);
  await withCheckoutGuard('ammu-sammu', true, async () => { const result = await prepareAttempt(storage, 'ammu-sammu', create); assert.equal(result.existing, true); sent.push(result.attempt.idempotencyKey); }, locks);
  assert.deepEqual(sent, ['key-1', 'key-1']); assert.equal(created, 1); assert.equal(readAttempt(stored, 'ammu-sammu')?.idempotencyKey, 'key-1');
});

test('auth redirects preserve only local allowlisted navigation targets', () => {
  const id = '40000000-0000-4000-8000-000000000001';
  assert.equal(webRedirectUrl(`https://app.test/login?next=/orders/${id}&code=secret`), `https://app.test/login?next=${encodeURIComponent(`/orders/${id}`)}`);
  assert.equal(webRedirectUrl('https://app.test/login?next=https://evil.test/&code=secret'), 'https://app.test/login');
});
