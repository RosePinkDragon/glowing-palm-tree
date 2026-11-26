import type { PricingTerms } from '@market/services';
import { bannerText, billTotals, discountLabel, nudgeText, offerChangedMessage, offerDescription, offerErrorMessage, quoteSignature, revisedDiscountLine, quotedOffer, retryMinutes } from './offer-model.ts';
import { capturePricing } from './pricing-model.ts';
import type { CartLine as OfferCartLine, MenuItem } from '@market/core';
import { webRedirectUrl } from './auth-callback.ts';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { menuItem } from '../../../tests/fixtures/menu.ts';
import { freezeAttempt, isDefiniteOrderRejection, isSignInRequired, readAttempt, sameIdentity, signInRequiredOutcome, signedOutCheckoutNote } from './checkout-state.ts';
import { cleanupDecision, ensureLeaveRequest, leaveFailure, leaveRequestIsFinal, leaveRetryCopy, leaveTarget, type LeaveLink, type LeaveStorage } from './leave-model.ts';

test('a persisted attempt preserves the original request for retries', () => {
  const source = { businessId: 'ammu-sammu' as const, userId: 'user', idempotencyKey: 'key', pricing: { lines: [{ menu_item_id: 'dish', quantity: 1, unit_price_paise: 100, line_total_paise: 100 }], delivery_fee_paise: 20, min_order_paise: 50, subtotal_paise: 100, total_paise: 120 }, lines: [{ item: menuItem(), quantity: 1 }], delivery: { name: 'Name', phone: '123' }, location: { latitude: 1, longitude: 2, accuracy: 3, capturedAtISO: '2026-01-01T00:00:00Z' }, savedAddress: { id: '48200000-0000-4000-8000-000000000001', version: 3 } };
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
  assert.equal(isDefiniteOrderRejection(error('Join this restaurant before placing an order.', 'BUSINESS_JOIN_REQUIRED')), false, 'a replay may already exist: keep the attempt');
  assert.equal(isDefiniteOrderRejection(error('Retry when it finishes.', 'BUSINESS_LIFECYCLE_PENDING')), false);
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
  const create = () => freezeAttempt({ businessId: 'ammu-sammu', userId: 'a', idempotencyKey: `key-${++created}`, pricing: { lines: [], delivery_fee_paise: 0, min_order_paise: 0, subtotal_paise: 0, total_paise: 0 }, lines: [], delivery: { name: 'A', phone: '1' }, location: { latitude: 1, longitude: 2, accuracy: 3, capturedAtISO: '2026-01-01T00:00:00Z' }, savedAddress: { id: '48200000-0000-4000-8000-000000000001', version: 3 } });
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
  const original = freezeAttempt({ businessId: 'ammu-sammu', userId: 'a', idempotencyKey: 'original-key', lines, pricing: capturePricing(lines, 20, 50), delivery: { name: 'Private sender', phone: '1' }, location: { latitude: 0.5, longitude: 0.5, accuracy: 10, capturedAtISO: '2026-11-14T00:00:00Z' }, savedAddress: { id: '48200000-0000-4000-8000-000000000001', version: 3 } });
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

test('a version 1 or malformed persisted attempt is discarded with the contact message instead of crashing', () => {
  const legacy = { version: 1, businessId: 'ammu-sammu', userId: 'user', idempotencyKey: 'key', lines: [], pricing: { lines: [] }, delivery: { name: 'N', phone: '1', addressLine: 'Typed address line' }, location: { latitude: 1, longitude: 2, accuracy: 3, capturedAtISO: '2026-01-01T00:00:00Z' } };
  const unreadable = /could not be read/;
  assert.throws(() => readAttempt(JSON.stringify(legacy), 'ammu-sammu'), unreadable, 'version 1 is no longer replayed');
  assert.throws(() => readAttempt('{not json', 'ammu-sammu'), unreadable);
  assert.throws(() => readAttempt(JSON.stringify({ ...legacy, savedAddress: { id: 'x', version: 1 } }), 'ammu-sammu'), unreadable, 'version 1 even with an address');
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
  assert.equal(near.amount, '₹390', 'only the amount is bold');
  assert.equal(confirmationCopy({ kind: 'remote', distanceM: 60_000, notInKhed: true }, address, 103000).title, 'You\'re not in Khed right now');
  const none = confirmationCopy({ kind: 'unknown' }, address, 39000);
  assert.equal(none.title, 'We couldn\'t confirm where you are');
  assert.match(none.lead, /Your phone didn't share its location/);
  assert.deepEqual(validateContact({ name: ' Rohan Sawant ', phone: '98765 43210' }), { name: 'Rohan Sawant', phone: '+919876543210' });
  assert.throws(() => validateContact({ name: 'R', phone: '12' }));
});

test('the phone fix is dropped, not awaited forever, when it fails or never answers', async () => {
  const { withTimeout } = await import('./checkout-model.ts');
  assert.equal(await withTimeout(Promise.resolve(5), 50), 5);
  assert.equal(await withTimeout(Promise.reject(new Error('denied')), 50), null);
  assert.equal(await withTimeout(new Promise(() => {}), 20), null);
});

// #52 leave rules (kept here so the package test list stays unchanged)

const link = (slug: 'ammu-sammu' | 'kokani-dine-inn', name: string, generation: string, state: LeaveLink['state'] = 'active'): LeaveLink => ({ businessSlug: slug, businessName: name, generation, state });
const memory = (): LeaveStorage & { map: Map<string, string> } => { const map = new Map<string, string>(); return { map, getItem: async k => map.get(k) ?? null, setItem: async (k, v) => { map.set(k, v); }, removeItem: async k => { map.delete(k); } }; };
const err = (code: string, message = 'RAW backend text') => Object.assign(new Error(message), { code });

test('Leave appears only for an active link here plus another active restaurant, naming the other from data', () => {
  assert.deepEqual(leaveTarget([link('ammu-sammu', 'Ammu Sammu', 'g1'), link('kokani-dine-inn', 'Kokani Dine Inn', 'g2')], 'ammu-sammu'), { generation: 'g1', otherName: 'Kokani Dine Inn' });
  assert.deepEqual(leaveTarget([link('ammu-sammu', 'Ammu Sammu', 'g1'), link('kokani-dine-inn', 'Kokani Dine Inn', 'g2')], 'kokani-dine-inn'), { generation: 'g2', otherName: 'Ammu Sammu' });
  assert.equal(leaveTarget([link('ammu-sammu', 'Ammu Sammu', 'g1')], 'ammu-sammu'), null);
  assert.equal(leaveTarget([link('ammu-sammu', 'Ammu Sammu', 'g1'), link('kokani-dine-inn', 'Kokani Dine Inn', 'g2', 'left')], 'ammu-sammu'), null);
  assert.equal(leaveTarget([link('ammu-sammu', 'Ammu Sammu', 'g1', 'left'), link('kokani-dine-inn', 'Kokani Dine Inn', 'g2')], 'ammu-sammu'), null);
  assert.equal(leaveTarget([link('ammu-sammu', 'Ammu Sammu', 'g1'), link('kokani-dine-inn', 'Kokani Dine Inn', 'g2', 'leave_pending')], 'ammu-sammu'), null);
  assert.equal(leaveTarget(null, 'ammu-sammu'), null);
});

test('the request ID is persisted per user and generation, reused on retry and replaced for a new generation', async () => {
  const storage = memory(); let n = 0; const fresh = () => `id-${++n}`;
  assert.equal(await ensureLeaveRequest(storage, 'ammu-sammu', 'u1', 'g1', fresh), 'id-1');
  assert.equal(await ensureLeaveRequest(storage, 'ammu-sammu', 'u1', 'g1', fresh), 'id-1', 'a retry after a lost response reuses it');
  assert.equal(await ensureLeaveRequest(storage, 'ammu-sammu', 'u2', 'g1', fresh), 'id-2', 'another user is isolated');
  assert.equal(await ensureLeaveRequest(storage, 'kokani-dine-inn', 'u1', 'g1', fresh), 'id-3', 'another restaurant is isolated');
  assert.equal(await ensureLeaveRequest(storage, 'ammu-sammu', 'u1', 'g9', fresh), 'id-4', 'a later generation never reuses an old request');
  storage.map.set([...storage.map.keys()][0], '{not json');
  assert.equal(await ensureLeaveRequest(storage, 'ammu-sammu', 'u1', 'g9', fresh), 'id-5', 'corrupt storage is replaced');
});

test('local cleanup is scoped to the receipt generation and the server still showing it as left', () => {
  const sent = { slug: 'ammu-sammu' as const, generation: 'g1', requestId: 'r1' };
  const receipt = { state: 'left', generation: 'g1', requestId: 'r1', localCleanup: { businessSlug: 'ammu-sammu' as const, generation: 'g1', requestId: 'r1' } };
  assert.equal(cleanupDecision(receipt, sent, link('ammu-sammu', 'Ammu Sammu', 'g1', 'left')), 'clean');
  assert.equal(cleanupDecision(receipt, sent, link('ammu-sammu', 'Ammu Sammu', 'g2')), 'superseded', 'replayed receipt after a rejoin');
  assert.equal(cleanupDecision(receipt, sent, link('ammu-sammu', 'Ammu Sammu', 'g1')), 'invalid', 'not left on the server');
  assert.equal(cleanupDecision(receipt, sent, undefined), 'invalid');
  assert.equal(cleanupDecision({ ...receipt, generation: 'g0' }, sent, link('ammu-sammu', 'Ammu Sammu', 'g1', 'left')), 'invalid');
  assert.equal(cleanupDecision({ ...receipt, localCleanup: { ...receipt.localCleanup, businessSlug: 'kokani-dine-inn' } }, sent, link('ammu-sammu', 'Ammu Sammu', 'g1', 'left')), 'invalid');
  assert.equal(cleanupDecision({ ...receipt, requestId: 'r2' }, sent, link('ammu-sammu', 'Ammu Sammu', 'g1', 'left')), 'invalid');
});

test('errors map to fixed copy and never expose raw text', () => {
  assert.match(leaveFailure(err('ACTIVE_ORDERS'), 'Ammu Sammu').message, /delivered or cancelled/);
  assert.match(leaveFailure(err('LAST_BUSINESS'), 'Ammu Sammu').message, /only restaurant/);
  assert.deepEqual(leaveFailure(err('BUSINESS_LIFECYCLE_PENDING'), 'X'), { message: 'Your account is being updated. Try again shortly.', retry: true, refresh: false, signIn: false });
  assert.equal(leaveFailure(err('STALE_RELATIONSHIP'), 'X').refresh, true);
  assert.equal(leaveFailure(err('SESSION_CHANGED'), 'X').signIn, true);
  for (const e of [err('BUSINESS_LEAVE_FAILED'), err('INVALID_RESPONSE'), new TypeError('Failed to fetch RAW'), 'string', null]) {
    const failure = leaveFailure(e, 'X'); assert.equal(failure.message, leaveRetryCopy); assert.equal(failure.retry, true); assert.doesNotMatch(failure.message, /RAW/);
  }
  assert.equal(leaveRequestIsFinal(err('ACTIVE_ORDERS')), true);
  assert.equal(leaveRequestIsFinal(err('BUSINESS_LEAVE_FAILED')), false);
  assert.equal(leaveRequestIsFinal(err('BUSINESS_LIFECYCLE_PENDING')), false);
});

// Offers in the cart (#182 slice C): wording, quote bookkeeping, accepted pricing and the saved code.
{

const item = (id: string, pricePaise: number) => ({ id, businessId: 'ammu-sammu', name: id, pricePaise, isAvailable: true, isDemo: false }) as unknown as MenuItem;
const lines: OfferCartLine[] = [{ item: item('a', 30000), quantity: 2 }];
const offer = { id: '00000000-0000-4000-8000-000000000001', name: 'Launch offer', code: null, kind: 'percent' as const };

test('offer descriptions and the banner', () => {
  assert.equal(offerDescription({ kind: 'percent', value: 20, maxDiscountPaise: 10000, minOrderPaise: 30000 }), '20% off up to ₹100 on orders above ₹300');
  assert.equal(offerDescription({ kind: 'flat', value: 5000, minOrderPaise: 0 }), '₹50 off');
  assert.equal(offerDescription({ kind: 'free_delivery', value: null, minOrderPaise: 20000 }), 'Free delivery on orders above ₹200');
  assert.equal(bannerText([]), null);
  assert.equal(bannerText([{ kind: 'flat', value: 5000, minOrderPaise: 0 }, { kind: 'free_delivery', value: null, minOrderPaise: 0 }] as never), '₹50 off (+1 more)');
  assert.equal(nudgeText({ offerId: 'x', name: 'n', kind: 'percent', value: 20, shortfallPaise: 5000 }), 'Add ₹50 more to get 20% off');
  assert.equal(nudgeText({ offerId: 'x', name: 'n', kind: 'free_delivery', value: null, shortfallPaise: 5000 }), 'Add ₹50 more to get free delivery');
});

test('every refusal has friendly copy; not found and ended read the same', () => {
  assert.equal(offerErrorMessage({ reason: 'not_found' }), 'This code isn\'t valid');
  assert.equal(offerErrorMessage({ reason: 'ended' }), 'This code isn\'t valid');
  assert.equal(offerErrorMessage({ reason: 'used_up' }), 'This offer has run out');
  assert.equal(offerErrorMessage({ reason: 'min_order', shortfallPaise: 5000 }), 'Add ₹50 more to use this code');
  assert.equal(offerErrorMessage({ reason: 'per_customer_limit' }), 'You\'ve already used this code');
  assert.equal(offerErrorMessage({ reason: 'first_order_only' }), 'This code is only for your first order here');
  assert.equal(offerErrorMessage({ reason: 'rate_limited', retryAfterSeconds: 61 }), 'Too many tries. Try again in 2 min');
  assert.equal(offerErrorMessage({ reason: 'rate_limited', retryAfterSeconds: 5 }), 'Too many tries. Try again in 1 min');
  assert.equal(retryMinutes(undefined), 1);
  for (const reason of ['paused', 'not_started', 'outside_window', 'no_benefit', 'changed'] as const) assert.ok(offerErrorMessage({ reason }).length > 10);
});

test('offer changed at place time names the reason and the repriced total', () => {
  const text = offerChangedMessage({ reason: 'used_up' }, 62000);
  assert.match(text, /^Your offer changed: the offer has run out\./);
  assert.match(text, /₹620/); assert.match(text, /Tap Place order/);
  assert.equal(offerChangedMessage({ reason: 'rate_limited', retryAfterSeconds: 120 }, 62000), 'Too many code tries, so we removed it. Your total is now ₹620. You can try a code again in 2 min.');
  assert.match(offerChangedMessage({ reason: 'rate_limited' }, 62000), /try a code again in 1 min\.$/);
});

test('the revised order shows the discount when either quote has an offer', () => {
  const launch = { id: 'o1', name: 'Launch offer', code: null, kind: 'percent' as const }, flat = { id: 'o2', name: 'Flat 50', code: 'SAVE50', kind: 'flat' as const };
  assert.equal(revisedDiscountLine({}, {}), null);
  assert.equal(revisedDiscountLine({ discount_paise: 10000, offer: launch }, { discount_paise: 5000, offer: launch }), 'Discount (Launch offer): −₹100 → −₹50');
  assert.equal(revisedDiscountLine({ discount_paise: 10000, offer: launch }, {}), 'Discount (Launch offer): −₹100 → ₹0');
  assert.equal(revisedDiscountLine({}, { discount_paise: 5000, offer: flat }), 'Discount (Flat 50): ₹0 → −₹50');
  assert.equal(revisedDiscountLine({ discount_paise: 10000, offer: launch }, { discount_paise: 5000, offer: flat }), 'Discount (Flat 50): −₹100 → −₹50', 'the new offer names the line');
});

test('the quote signature changes with quantities, prices and the fee', () => {
  const base = quoteSignature(lines, 2000, 0);
  assert.equal(base, quoteSignature(lines, 2000, 0));
  assert.notEqual(base, quoteSignature([{ ...lines[0], quantity: 3 }], 2000, 0));
  assert.notEqual(base, quoteSignature([{ item: item('a', 31000), quantity: 2 }], 2000, 0));
  assert.notEqual(base, quoteSignature(lines, 3000, 0));
});

test('accepted pricing carries the server discount and offer, and matches the server quote', () => {
  const none = capturePricing(lines, 2000, 0);
  assert.equal('discount_paise' in none || 'offer' in none, false, 'no offer: exactly the old contract');
  const server: PricingTerms = { ...none, discount_paise: 10000, offer, total_paise: 60000 + 2000 - 10000 };
  const mine = capturePricing(lines, 2000, 0, quotedOffer(server));
  assert.deepEqual(mine, server);
  assert.equal(capturePricing(lines, 2000, 0, quotedOffer(none)).total_paise, 62000);
  // A discount can never take the total below zero, even against a cart that shrank.
  assert.equal(capturePricing([{ item: item('a', 100), quantity: 1 }], 0, 0, { discount_paise: 99999, offer }).total_paise, 0);
  assert.deepEqual(billTotals(60000, 2000, quotedOffer(server)), { discountPaise: 10000, totalPaise: 52000 });
  assert.deepEqual(billTotals(60000, 2000, null), { discountPaise: 0, totalPaise: 62000 });
});

test('the saved attempt keeps the code, so a recovery replays the same request', () => {
  const attempt = freezeAttempt({ businessId: 'ammu-sammu', userId: 'u', idempotencyKey: 'k', lines, pricing: capturePricing(lines, 2000, 0), offerCode: 'SAVE20', delivery: { name: 'A', phone: '9876543210' }, savedAddress: { id: 'x', version: 1 }, location: null });
  assert.equal(readAttempt(JSON.stringify(attempt), 'ammu-sammu')?.offerCode, 'SAVE20');
  assert.equal(readAttempt(JSON.stringify({ ...attempt, offerCode: undefined }), 'ammu-sammu')?.offerCode, undefined, 'older attempts have no code');
  assert.throws(() => readAttempt(JSON.stringify({ ...attempt, offerCode: 5 }), 'ammu-sammu'));
});

test('owner label names the offer or its code', () => {
  assert.equal(discountLabel({ name: 'Launch offer', code: null }), 'Discount (Launch offer)');
  assert.equal(discountLabel({ name: '', code: 'SAVE20' }), 'Discount (SAVE20)');
  assert.equal(discountLabel(undefined), 'Discount');
});

}

test('an ended session at checkout keeps the attempt and cart, says so plainly, and never claims uncertainty', () => {
  const ended = Object.assign(new Error('Your session ended. Sign in again.'), { code: 'SIGN_IN_REQUIRED' });
  assert.equal(isSignInRequired(ended), true);
  assert.deepEqual(signInRequiredOutcome(ended), { keepAttempt: true, keepCart: true, signOutLocally: true, goToSignIn: '/cart', note: signedOutCheckoutNote });
  assert.match(signedOutCheckoutNote, /signed out/); assert.doesNotMatch(signedOutCheckoutNote, /uncertain/);
  assert.equal(isDefiniteOrderRejection(ended), false, 'the saved attempt must not be released');
  for (const other of [new Error('x'), Object.assign(new Error('x'), { code: 'NOT_ACCEPTING_ORDERS' }), Object.assign(new Error('x'), { code: '42501' }), 'SIGN_IN_REQUIRED', null]) {
    assert.equal(isSignInRequired(other), false); assert.equal(signInRequiredOutcome(other), null);
  }
  // Signing back in is a new identity generation, so the identity-mismatch handling still decides whose attempt it is.
  assert.equal(sameIdentity({ userId: 'u', generation: 1 }, { userId: null, generation: 2 }), false);
});
