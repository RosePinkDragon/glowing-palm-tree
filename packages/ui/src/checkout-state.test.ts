import { webRedirectUrl } from './auth-callback.ts';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { menuItem } from '../../../tests/fixtures/menu.ts';
import { freezeAttempt, readAttempt } from './checkout-state.ts';

test('a persisted attempt preserves the original request for retries', () => {
  const source = { businessId: 'ammu-sammu' as const, userId: 'user', idempotencyKey: 'key', pricing: { lines: [{ menu_item_id: 'dish', quantity: 1, unit_price_paise: 100, line_total_paise: 100 }], delivery_fee_paise: 20, min_order_paise: 50, subtotal_paise: 100, total_paise: 120 }, lines: [{ item: menuItem(), quantity: 1 }], delivery: { name: 'Name', phone: '123', addressLine: 'Address' }, location: { latitude: 1, longitude: 2, accuracy: 3, capturedAtISO: '2026-01-01T00:00:00Z' } };
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
  assert.equal(isDefiniteOrderRejection(error('The restaurant is not taking orders right now.', 'NOT_ACCEPTING_ORDERS')), true);
  assert.equal(isDefiniteOrderRejection(error('Could not place order: restaurant is not accepting orders', 'PT409')), false);
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
  const create = () => freezeAttempt({ businessId: 'ammu-sammu', userId: 'a', idempotencyKey: `key-${++created}`, pricing: { lines: [], delivery_fee_paise: 0, min_order_paise: 0, subtotal_paise: 0, total_paise: 0 }, lines: [], delivery: { name: 'A', phone: '1', addressLine: 'Address' }, location: { latitude: 1, longitude: 2, accuracy: 3, capturedAtISO: '2026-01-01T00:00:00Z' } });
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

test('accepted terms stay frozen and revised quotes disappear at identity boundaries', async () => {
  const { capturePricing, revisedLines, visibleQuote } = await import('./pricing-model.ts');
  const lines = [{ item: menuItem({ name: 'Private dish' }), quantity: 2 }];
  const original = freezeAttempt({ businessId: 'ammu-sammu', userId: 'a', idempotencyKey: 'original-key', lines, pricing: capturePricing(lines, 20, 50), delivery: { name: 'Private sender', phone: '1', addressLine: 'Private address' }, location: { latitude: 0.5, longitude: 0.5, accuracy: 10, capturedAtISO: '2026-11-14T00:00:00Z' } });
  const accepted = JSON.stringify(original);
  lines[0].item.pricePaise = 300;
  const identity = { userId: 'a', generation: 1 };
  const quote = { original, identity, sourceCart: 'saved-cart-revision', pricing: capturePricing(lines, 40, 500) };
  assert.equal(quote.pricing.subtotal_paise < quote.pricing.min_order_paise, false);
  assert.equal(visibleQuote(quote, identity, true), quote);
  assert.equal(visibleQuote(quote, identity, false), null);
  assert.equal(visibleQuote(quote, { userId: null, generation: 2 }, true), null);
  assert.equal(visibleQuote(quote, { userId: 'b', generation: 2 }, true), null);
  assert.equal(visibleQuote(quote, { userId: 'a', generation: 3 }, true), null);
  assert.equal(revisedLines(quote)[0].item.pricePaise, 300);
  assert.equal(JSON.stringify(original), accepted);
  assert.equal(original.pricing.delivery_fee_paise, 20);
  assert.equal(original.pricing.min_order_paise, 50);
  assert.equal(original.pricing.lines[0].unit_price_paise, 100);
});

const savedSource = () => ({ businessId: 'ammu-sammu' as const, userId: 'user', idempotencyKey: 'key', pricing: { lines: [{ menu_item_id: 'dish', quantity: 1, unit_price_paise: 100, line_total_paise: 100 }], delivery_fee_paise: 20, min_order_paise: 50, subtotal_paise: 100, total_paise: 120 }, lines: [{ item: menuItem(), quantity: 1 }], delivery: { name: 'Name', phone: '+919876543210' }, savedAddress: { id: '48200000-0000-4000-8000-000000000001', version: 3 }, location: null });

test('a saved-address attempt keeps the address and a missing phone location for retries', () => {
  const frozen = freezeAttempt(savedSource());
  assert.equal(frozen.version, 2);
  const restored = readAttempt(JSON.stringify(frozen), 'ammu-sammu');
  assert.deepEqual(restored?.savedAddress, { id: '48200000-0000-4000-8000-000000000001', version: 3 });
  assert.equal(restored?.location, null);
  assert.equal('addressLine' in (restored?.delivery ?? {}), false);
  assert.deepEqual(restored, frozen, 'a retry sends the identical payload');
  const withFix = freezeAttempt({ ...savedSource(), location: { latitude: 17.7, longitude: 73.4, accuracy: 20, capturedAtISO: '2026-11-17T10:00:00Z' } });
  assert.equal(readAttempt(JSON.stringify(withFix), 'ammu-sammu')?.location?.accuracy, 20);
});

test('an older persisted attempt is still read, and unreadable ones fail with the contact message instead of crashing', async () => {
  const { orderInput } = await import('./checkout-state.ts');
  const legacy = { version: 1, businessId: 'ammu-sammu', userId: 'user', idempotencyKey: 'key', lines: [], pricing: { lines: [] }, delivery: { name: 'N', phone: '1', addressLine: 'Typed address line' }, location: { latitude: 1, longitude: 2, accuracy: 3, capturedAtISO: '2026-01-01T00:00:00Z' } };
  const restored = readAttempt(JSON.stringify(legacy), 'ammu-sammu');
  assert.equal(restored?.delivery.addressLine, 'Typed address line');
  assert.equal(orderInput(restored!).delivery.addressLine, 'Typed address line');
  assert.equal(orderInput(freezeAttempt(savedSource())).delivery.addressLine, '');
  const unreadable = /could not be read/;
  assert.throws(() => readAttempt('{not json', 'ammu-sammu'), unreadable);
  assert.throws(() => readAttempt(JSON.stringify({ ...legacy, location: null }), 'ammu-sammu'), unreadable, 'legacy needs its fix');
  assert.throws(() => readAttempt(JSON.stringify({ ...legacy, delivery: { name: 'N', phone: '1' } }), 'ammu-sammu'), unreadable, 'legacy needs its typed line');
  assert.throws(() => readAttempt(JSON.stringify({ ...legacy, savedAddress: { id: 'x', version: 1 } }), 'ammu-sammu'), unreadable);
  assert.throws(() => readAttempt(JSON.stringify({ ...freezeAttempt(savedSource()), savedAddress: undefined }), 'ammu-sammu'), unreadable, 'version 2 needs its address');
  assert.throws(() => readAttempt(JSON.stringify({ ...freezeAttempt(savedSource()), savedAddress: { id: 'x', version: 0 } }), 'ammu-sammu'), unreadable);
  assert.throws(() => readAttempt(JSON.stringify({ ...legacy, version: 3 }), 'ammu-sammu'), unreadable);
  assert.throws(() => readAttempt('null', 'ammu-sammu'), unreadable);
});

test('a changed address and one outside the area are definite rejections that release the attempt', async () => {
  const { isDefiniteOrderRejection } = await import('./checkout-state.ts');
  const error = (code: string) => Object.assign(new Error('x'), { code });
  assert.equal(isDefiniteOrderRejection(error('ADDRESS_CHANGED')), true);
  assert.equal(isDefiniteOrderRejection(error('DELIVERY_UNAVAILABLE')), true);
  assert.equal(isDefiniteOrderRejection(error('SIGN_IN_REQUIRED')), false);
  assert.equal(isDefiniteOrderRejection(error('LOCATION_REQUIRED')), false);
  assert.equal(isDefiniteOrderRejection(error('INVALID_RESPONSE')), false);
});

test('the phone-to-pin distance decides whether the customer confirms first', async () => {
  const { confirmationFor, confirmationCopy, distanceMetres, validateContact } = await import('./checkout-model.ts');
  const pin = { latitude: 17.72, longitude: 73.39 };
  const fix = (north: number) => ({ latitude: 17.72 + north / 111_195, longitude: 73.39, accuracy: 10, capturedAtISO: '2026-11-17T10:00:00Z' });
  assert.ok(Math.abs(distanceMetres(pin, { latitude: 17.72, longitude: 74.39 }) - 106_000) < 1500, 'one degree of longitude near 17.7 N');
  assert.equal(distanceMetres(pin, pin), 0);
  assert.deepEqual(confirmationFor(fix(0), pin), { kind: 'direct' });
  assert.deepEqual(confirmationFor(fix(140), pin), { kind: 'direct' }, 'within 150 m places directly');
  const edge = confirmationFor(fix(151), pin);
  assert.equal(edge.kind, 'remote');
  assert.equal(confirmationFor(fix(3200), pin).kind === 'remote' && (confirmationFor(fix(3200), pin) as { notInKhed: boolean }).notInKhed, false);
  assert.equal((confirmationFor(fix(60_000), pin) as { notInKhed: boolean }).notInKhed, true);
  assert.deepEqual(confirmationFor(null, pin), { kind: 'unknown' });
  assert.deepEqual(confirmationFor({ ...fix(0), latitude: Number.NaN }, pin), { kind: 'unknown' });
  const address = { id: 'a', version: 1, label: 'home' as const, house: 'Flat 3', streetArea: 'Sai Krupa Apartments, Bharne Naka', latitude: 17.72, longitude: 73.39, locationSource: 'pin' as const, updatedAtISO: '', inArea: true, distanceM: 1200 };
  const near = confirmationCopy(confirmationFor(fix(3200), pin) as never, address, 39000);
  assert.equal(near.title, 'You\'re 3.2 km from this address');
  assert.equal(near.lead, 'You\'re ordering to Home, Flat 3, Sai Krupa Apartments, Bharne Naka. Is that right?');
  assert.match(near.cash, /pay ₹390 in cash/);
  assert.equal(confirmationCopy({ kind: 'remote', distanceM: 60_000, notInKhed: true }, address, 103000).title, 'You\'re not in Khed right now');
  const none = confirmationCopy({ kind: 'unknown' }, address, 39000);
  assert.equal(none.title, 'We couldn\'t confirm where you are');
  assert.match(none.lead, /Your phone didn't share its location/);
  assert.deepEqual(validateContact({ name: ' Rohan Sawant ', phone: '98765 43210' }), { name: 'Rohan Sawant', phone: '+919876543210' });
  assert.throws(() => validateContact({ name: 'R', phone: '12' }));
});
