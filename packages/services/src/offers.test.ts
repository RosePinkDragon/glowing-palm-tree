import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMarketServices, offerError, OfferError, ServiceError, validateRevisedPricing, type PlaceOrderInput } from './index.ts';

const slug = 'ammu-sammu' as const;
const businessId = '10000000-0000-4000-8000-000000000001';
const offerId = '18200000-0000-4000-b000-000000000001';
const dishId = '20000000-0000-4000-8000-000000000001';
const item = { id: dishId, businessId: slug, name: 'Dish', description: '', category: 'Main', categoryId: 'category-main', categorySortOrder: 0, diet: null, pricePaise: 30000, isAvailable: true, isDemo: false, isFeatured: false, sortOrder: 0 };
const lines = [{ item, quantity: 2 }];
const plain = { lines: [{ menu_item_id: dishId, quantity: 2, unit_price_paise: 30000, line_total_paise: 60000 }], delivery_fee_paise: 5000, min_order_paise: 0, subtotal_paise: 60000, total_paise: 65000 };
const snapshot = { id: offerId, name: '20 percent off', code: null, kind: 'percent' as const };
const discounted = { ...plain, discount_paise: 10000, offer: snapshot, total_paise: 55000 };
const isOffer = (code: string, reason?: string) => (e: unknown) => e instanceof OfferError && e.code === code && (reason === undefined || e.reason === reason);

type Call = { path: string; body: Record<string, unknown> };
/** A deterministic HTTP fixture: each RPC path answers with whatever `answers` holds at that moment. */
async function withService(answers: Record<string, () => Response>, run: (service: ReturnType<typeof createMarketServices>, calls: Call[]) => Promise<void>) {
  const originalFetch = globalThis.fetch;
  const calls: Call[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/businesses')) return Response.json({ id: businessId, slug, name: 'Test', delivery_fee_paise: 5000, min_order_paise: 0, is_demo: false, ordering_enabled: true, accepting_orders: true });
    const name = url.pathname.split('/').pop() as string;
    if (url.pathname.includes('/rpc/') && answers[name]) { calls.push({ path: name, body: JSON.parse(String(init?.body)) }); return answers[name](); }
    if (url.pathname.endsWith('/orders') && answers.orders) return answers.orders();
    throw new Error('Unexpected request ' + url);
  };
  const service = createMarketServices({ businessSlug: slug, audience: 'customer', config: { url: 'https://offers.example.test', anonKey: 'sb_publishable_test' }, storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } });
  try { await run(service, calls); } finally { service.dispose(); globalThis.fetch = originalFetch; }
}

test('offer errors have stable codes, reasons and wording', () => {
  const table: [unknown, string, string][] = [
    ['not_found', 'OFFER_NOT_FOUND', 'not_found'], ['used_up', 'OFFER_USED_UP', 'used_up'], ['rate_limited', 'OFFER_RATE_LIMITED', 'rate_limited'],
    ['paused', 'OFFER_NOT_ELIGIBLE', 'paused'], ['ended', 'OFFER_NOT_ELIGIBLE', 'ended'], ['not_started', 'OFFER_NOT_ELIGIBLE', 'not_started'], ['outside_window', 'OFFER_NOT_ELIGIBLE', 'outside_window'],
    ['first_order_only', 'OFFER_NOT_ELIGIBLE', 'first_order_only'], ['per_customer_limit', 'OFFER_NOT_ELIGIBLE', 'per_customer_limit'], ['min_order', 'OFFER_NOT_ELIGIBLE', 'min_order'], ['no_benefit', 'OFFER_NOT_ELIGIBLE', 'no_benefit'],
    ['something new', 'OFFER_NOT_ELIGIBLE', 'changed'], [undefined, 'OFFER_NOT_ELIGIBLE', 'changed'],
  ];
  for (const [reason, code, expected] of table) assert.ok(isOffer(code, expected)(offerError(reason)), `${String(reason)} -> ${code}`);
  assert.equal(offerError('per_customer_limit').message, 'You\'ve already used this code');
  assert.ok(offerError('paused', { changed: true }) instanceof ServiceError);
  assert.ok(isOffer('OFFER_CHANGED', 'paused')(offerError('paused', { changed: true })));
  assert.equal(offerError('min_order', { shortfallPaise: 5000 }).shortfallPaise, 5000);
  assert.equal(offerError('min_order', { shortfallPaise: -1 }).shortfallPaise, undefined, 'a malformed amount is dropped');
  assert.equal(offerError('rate_limited', { retryAfterSeconds: 42 }).retryAfterSeconds, 42);
  assert.equal(offerError('rate_limited').retryAfterSeconds, 60, 'a missing wait still tells the customer to wait');
});

test('revised pricing keeps the old contract without an offer and validates an offer completely', () => {
  assert.deepEqual(validateRevisedPricing(plain, lines), plain, 'no offer: exactly the old keys');
  assert.deepEqual(validateRevisedPricing(discounted, lines), discounted);
  assert.deepEqual(validateRevisedPricing({ ...discounted, offer: { ...snapshot, code: 'SAVE20', kind: 'flat' }, extra: 'ignored' }, lines).offer, { ...snapshot, code: 'SAVE20', kind: 'flat' }, 'unknown fields are never copied');
  assert.deepEqual(validateRevisedPricing({ ...plain, discount_paise: 5000, offer: { ...snapshot, kind: 'free_delivery' }, total_paise: 60000 }, lines).total_paise, 60000, 'free delivery takes off the fee');
  assert.deepEqual(validateRevisedPricing({ ...plain, discount_paise: 65000, offer: snapshot, total_paise: 0 }, lines).total_paise, 0, 'a total of zero is valid, never negative');
  const bad: unknown[] = [
    { ...discounted, total_paise: 65000 }, { ...discounted, total_paise: 54999 }, { ...discounted, discount_paise: 0, total_paise: 65000 }, { ...discounted, discount_paise: -1 }, { ...discounted, discount_paise: 1.5 },
    { ...discounted, discount_paise: 65001, total_paise: -1 }, { ...plain, discount_paise: 10000, total_paise: 55000 }, { ...plain, offer: snapshot },
    { ...discounted, offer: { ...snapshot, kind: 'bogo' } }, { ...discounted, offer: { ...snapshot, id: 'nope' } }, { ...discounted, offer: { ...snapshot, name: '' } }, { ...discounted, offer: { ...snapshot, code: 'ab' } },
    { ...discounted, offer: null }, { ...discounted, offer: { ...snapshot, kind: 'free_delivery' } },
  ];
  for (const value of bad) assert.throws(() => validateRevisedPricing(value, lines), (e: unknown) => e instanceof ServiceError && e.code === 'INVALID_RESPONSE', JSON.stringify(value));
});

test('checkOfferCode normalises the code, scopes the restaurant and returns typed errors', async () => {
  let answer: () => Response = () => Response.json({ applies: true, reason: null, retry_after_seconds: null, offer: { id: offerId, name: 'Welcome', kind: 'flat', value: 1000, max_discount_paise: null, min_order_paise: 20000, first_order_only: true } });
  await withService({ check_offer_code: () => answer() }, async (service, calls) => {
    const ok = await service.checkOfferCode(businessId, '  welcome1 ');
    assert.deepEqual(calls[0], { path: 'check_offer_code', body: { p_business_slug: slug, p_code: 'WELCOME1' } });
    assert.deepEqual(ok, { id: offerId, name: 'Welcome', kind: 'flat', value: 1000, maxDiscountPaise: null, minOrderPaise: 20000, firstOrderOnly: true });
    assert.ok(!('code' in ok), 'the result never carries a code');
    for (const [reason, code] of [['not_found', 'OFFER_NOT_FOUND'], ['used_up', 'OFFER_USED_UP'], ['per_customer_limit', 'OFFER_NOT_ELIGIBLE'], ['ended', 'OFFER_NOT_ELIGIBLE']] as const) {
      answer = () => Response.json({ applies: false, reason, retry_after_seconds: null, offer: null });
      await assert.rejects(service.checkOfferCode(businessId, 'WELCOME1'), isOffer(code, reason));
    }
    answer = () => Response.json({ applies: false, reason: 'rate_limited', retry_after_seconds: 240, offer: null });
    await assert.rejects(service.checkOfferCode(businessId, 'WELCOME1'), (e: unknown) => isOffer('OFFER_RATE_LIMITED', 'rate_limited')(e) && (e as OfferError).retryAfterSeconds === 240);
    const before = calls.length;
    for (const blank of ['', '   ', 'X'.repeat(65)]) await assert.rejects(service.checkOfferCode(businessId, blank), isOffer('OFFER_NOT_FOUND'));
    assert.equal(calls.length, before, 'a blank or oversized code never reaches the server');
    await assert.rejects(service.checkOfferCode('20000000-0000-4000-8000-000000000009', 'WELCOME1'), (e: unknown) => e instanceof ServiceError && e.code === 'BUSINESS_MISMATCH');
    assert.equal(calls.length, before, 'another restaurant is refused before any request');
    for (const invalid of [null, {}, { applies: 'yes' }, { applies: true, offer: { id: 'x' } }]) {
      answer = () => Response.json(invalid);
      await assert.rejects(service.checkOfferCode(businessId, 'WELCOME1'), (e: unknown) => e instanceof ServiceError && e.code === 'INVALID_RESPONSE');
    }
    answer = () => Response.json({ message: 'permission denied', code: '42501' }, { status: 401 });
    await assert.rejects(service.checkOfferCode(businessId, 'WELCOME1'), (e: unknown) => e instanceof ServiceError && e.code === 'AUTH_REQUIRED');
  });
});

test('quoteOrder sends the cart and code and returns validated pricing, the offer error and the nudge', async () => {
  let answer: () => Response = () => Response.json({ outcome: 'quoted', pricing: discounted, offer_error: null, nudge: null });
  await withService({ quote_order: () => answer() }, async (service, calls) => {
    const quote = await service.quoteOrder(lines, ' save20 ');
    assert.deepEqual(calls[0].body, { p_business_slug: slug, p_items: [{ menu_item_id: dishId, quantity: 2 }], p_offer_code: 'SAVE20' });
    assert.deepEqual(quote, { pricing: discounted, offerError: null, nudge: null });
    await service.quoteOrder(lines);
    assert.equal(calls[1].body.p_offer_code, null, 'no code is sent as null');
    answer = () => Response.json({ outcome: 'quoted', pricing: plain, offer_error: { reason: 'min_order', shortfall_paise: 40000 }, nudge: { offer_id: offerId, name: '20 percent off', kind: 'percent', value: 20, shortfall_paise: 5000 } });
    const short = await service.quoteOrder(lines, 'BIGCART');
    assert.deepEqual(short.pricing, plain);
    assert.ok(short.offerError && isOffer('OFFER_NOT_ELIGIBLE', 'min_order')(short.offerError) && short.offerError.shortfallPaise === 40000);
    assert.deepEqual(short.nudge, { offerId, name: '20 percent off', kind: 'percent', value: 20, shortfallPaise: 5000 });
    answer = () => Response.json({ outcome: 'quoted', pricing: plain, offer_error: { reason: 'rate_limited', retry_after_seconds: 120 }, nudge: { offer_id: 5 } });
    const limited = await service.quoteOrder(lines, 'GUESS123');
    assert.ok(limited.offerError && isOffer('OFFER_RATE_LIMITED')(limited.offerError) && limited.offerError.retryAfterSeconds === 120);
    assert.equal(limited.nudge, null, 'a malformed nudge is ignored');
    for (const invalid of [null, { outcome: 'other' }, { outcome: 'quoted', pricing: { ...discounted, total_paise: 1 } }, { outcome: 'quoted', pricing: null }]) {
      answer = () => Response.json(invalid);
      await assert.rejects(service.quoteOrder(lines), (e: unknown) => e instanceof ServiceError && e.code === 'INVALID_RESPONSE');
    }
    await assert.rejects(service.quoteOrder([{ item: { ...item, businessId: 'kokani-dine-inn' }, quantity: 1 }]), (e: unknown) => e instanceof ServiceError && e.code === 'BUSINESS_MISMATCH');
  });
});

test('offer code and quote requests distinguish expired sessions from signed-out callers', async () => {
  let failure = { code: '42501', message: 'invalid session', details: 'INVALID_SESSION' };
  const refused = () => Response.json(failure, { status: 403 });
  await withService({ check_offer_code: refused, quote_order: refused }, async (service) => {
    const checkCode = () => service.checkOfferCode(businessId, 'WELCOME1');
    const quote = () => service.quoteOrder(lines, 'WELCOME1');
    for (const request of [checkCode, quote]) {
      await assert.rejects(request, { name: 'ServiceError', code: 'SIGN_IN_REQUIRED', message: 'Your session ended. Sign in again.' });
    }

    failure = { code: '42501', message: 'authentication required', details: '' };
    await assert.rejects(checkCode, { name: 'ServiceError', code: 'AUTH_REQUIRED', message: 'Sign in to use a code.' });
    await assert.rejects(quote, { name: 'ServiceError', code: 'AUTH_REQUIRED', message: 'Sign in to get your prices.' });
  });
});

test('listActiveOffers maps the menu-safe listing and rejects malformed data', async () => {
  const listed = { id: offerId, name: 'Happy hour', kind: 'percent', value: 10, max_discount_paise: null, min_order_paise: 0, first_order_only: false, ends_at: '2026-12-01T00:00:00+00:00', window: { from: '15:00', to: '18:00', days: [1, 2, 3, 4, 5] } };
  let answer: () => Response = () => Response.json([listed, { ...listed, id: '18200000-0000-4000-b000-000000000002', name: 'Free delivery', kind: 'free_delivery', value: null, ends_at: null, window: null }]);
  await withService({ list_active_offers: () => answer() }, async (service, calls) => {
    const offers = await service.listActiveOffers();
    assert.deepEqual(calls[0], { path: 'list_active_offers', body: { p_business_slug: slug } });
    assert.deepEqual(offers[0], { id: offerId, name: 'Happy hour', kind: 'percent', value: 10, maxDiscountPaise: null, minOrderPaise: 0, firstOrderOnly: false, endsAtISO: '2026-12-01T00:00:00+00:00', window: { from: '15:00', to: '18:00', days: [1, 2, 3, 4, 5] } });
    assert.deepEqual(offers[1], { id: '18200000-0000-4000-b000-000000000002', name: 'Free delivery', kind: 'free_delivery', value: null, maxDiscountPaise: null, minOrderPaise: 0, firstOrderOnly: false, endsAtISO: null, window: null });
    answer = () => Response.json([]);
    assert.deepEqual(await service.listActiveOffers(), []);
    for (const invalid of [{}, null, [{ ...listed, kind: 'bogo' }], [{ ...listed, id: 'x' }], [{ ...listed, window: { from: '15:00', to: '18:00', days: [8] } }], [{ ...listed, min_order_paise: 'a' }]]) {
      answer = () => Response.json(invalid);
      await assert.rejects(service.listActiveOffers(), (e: unknown) => e instanceof ServiceError && e.code === 'INVALID_RESPONSE', JSON.stringify(invalid));
    }
  });
  const demo = createMarketServices({ businessSlug: slug, audience: 'customer', config: {}, storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } });
  try { assert.deepEqual(await demo.listActiveOffers(), [], 'demo mode has no offers'); } finally { demo.dispose(); }
});

const orderId = '40000000-0000-4000-8000-000000000001';
const request = (pricing: PlaceOrderInput['pricing'], offerCode?: string | null): PlaceOrderInput => ({ lines, pricing, offerCode, delivery: { name: 'Name', phone: '123' }, location: null, idempotencyKey: '60000000-0000-4000-8000-000000000001', savedAddress: { id: '74000000-0000-4000-8000-000000000001', version: 1 } });
const orderRow = (extra: Record<string, unknown> = {}) => ({ id: orderId, status: 'placed', version: 1, subtotal_paise: 60000, delivery_fee_paise: 5000, discount_paise: 10000, total_paise: 55000, offer_id: offerId, offer_name: '20 percent off', offer_code: null, offer_kind: 'percent',
  customer_name: 'Name', customer_phone: '123', delivery_address_line: 'Address', created_at: '2026-11-20T10:00:00Z',
  order_items: [{ menu_item_id: dishId, diet: null, name: 'Dish', quantity: 2, unit_price_paise: 30000, line_total_paise: 60000 }], order_status_history: [{ status: 'placed', created_at: '2026-11-20T10:00:00Z' }], ...extra });

test('demo restaurant refusal maps to the same customer message for quotes and placement', async () => {
  const refused = () => Response.json({ code: '22023', message: 'demo restaurant cannot take orders', details: 'DEMO_RESTAURANT' }, { status: 400 });
  await withService({ quote_order: refused, place_order: refused }, async (service, calls) => {
    const expected = { code: 'NOT_ACCEPTING_ORDERS', message: 'This is a sample restaurant. Ordering is unavailable.' };
    await assert.rejects(service.quoteOrder(lines), expected);
    await assert.rejects(service.placeOrder(request(plain)), expected);
    assert.deepEqual(calls.map(call => call.path), ['quote_order', 'place_order']);
  });
});

test('placeOrder passes the code, handles offer_changed and verifies the stored discount', async () => {
  let response: unknown = { outcome: 'placed', id: orderId, discount_paise: 10000 };
  let order: Record<string, unknown> = orderRow();
  await withService({ place_order: () => Response.json(response), orders: () => Response.json(order) }, async (service, calls) => {
    const placed = await service.placeOrder(request(discounted, ' save20 '));
    assert.equal(calls[0].body.p_offer_code, 'SAVE20', 'the code is normalised and sent');
    assert.deepEqual(calls[0].body.p_accepted_pricing, discounted);
    assert.equal(placed.totalPaise, 55000);
    assert.equal(placed.discountPaise, 10000);
    assert.deepEqual(placed.offer, snapshot);
    // Without a code the call is exactly the one clients built before offers make: no p_offer_code key at all.
    response = { outcome: 'placed', id: orderId }; order = orderRow({ discount_paise: 0, total_paise: 65000, offer_id: null, offer_name: null, offer_kind: null });
    const none = await service.placeOrder(request(plain));
    assert.deepEqual(Object.keys(calls[1].body).sort(), ['p_accepted_pricing', 'p_business_slug', 'p_delivery', 'p_idempotency_key', 'p_items', 'p_location']);
    assert.equal(none.discountPaise, undefined); assert.equal(none.offer, undefined);
    for (const blank of [null, '', '  ']) { await service.placeOrder(request(plain, blank)); assert.ok(!('p_offer_code' in calls[calls.length - 1].body)); }
    // A quoted offer that is gone: a distinct, handleable error with the new pricing. Nothing is dropped silently.
    response = { outcome: 'offer_changed', reason: 'used_up', pricing: plain };
    await assert.rejects(service.placeOrder(request(discounted, 'SAVE20')), (e: unknown) => isOffer('OFFER_CHANGED', 'used_up')(e) && JSON.stringify((e as OfferError).pricing) === JSON.stringify(plain));
    // Rate limited at place time: OFFER_RATE_LIMITED with the wait (and the pricing), not OFFER_CHANGED.
    response = { outcome: 'offer_changed', reason: 'rate_limited', retry_after_seconds: 180, pricing: plain };
    await assert.rejects(service.placeOrder(request(discounted, 'GUESS123')), (e: unknown) => isOffer('OFFER_RATE_LIMITED', 'rate_limited')(e) && (e as OfferError).retryAfterSeconds === 180 && JSON.stringify((e as OfferError).pricing) === JSON.stringify(plain));
    response = { outcome: 'offer_changed', reason: 'rate_limited', pricing: plain };
    await assert.rejects(service.placeOrder(request(discounted, 'GUESS123')), (e: unknown) => isOffer('OFFER_RATE_LIMITED')(e) && (e as OfferError).retryAfterSeconds === 60, 'a missing wait still says to wait');
    response = { outcome: 'offer_changed', reason: 'rate_limited', retry_after_seconds: 180, pricing: { ...plain, total_paise: 1 } };
    await assert.rejects(service.placeOrder(request(discounted, 'GUESS123')), (e: unknown) => e instanceof ServiceError && e.code === 'INVALID_RESPONSE');
    response = { outcome: 'offer_changed', reason: 'unheard of', pricing: plain };
    await assert.rejects(service.placeOrder(request(discounted)), isOffer('OFFER_CHANGED', 'changed'));
    for (const invalid of [{ outcome: 'offer_changed', reason: 'paused', pricing: { ...plain, total_paise: 1 } }, { outcome: 'offer_changed', reason: 'paused', pricing: plain, id: orderId }, { outcome: 'offer_changed', reason: 'paused' }]) {
      response = invalid;
      await assert.rejects(service.placeOrder(request(discounted)), (e: unknown) => e instanceof ServiceError && e.code === 'INVALID_RESPONSE');
    }
    // The stored order must match what was accepted, discount included.
    response = { outcome: 'placed', id: orderId, discount_paise: 10000 };
    for (const wrong of [{ discount_paise: 9000, total_paise: 56000 }, { offer_id: '18200000-0000-4000-b000-000000000009' }, { offer_id: null, offer_name: null, offer_kind: null }]) {
      order = orderRow(wrong);
      await assert.rejects(service.placeOrder(request(discounted, 'SAVE20')), /does not match the accepted pricing/, JSON.stringify(wrong));
    }
    order = orderRow();
    response = { outcome: 'placed', id: orderId, discount_paise: 0 };
    await assert.rejects(service.placeOrder(request(discounted, 'SAVE20')), /does not match the accepted pricing/, 'the RPC result must agree on the discount too');
  });
});

test('quoteOrder gives up on a request that never answers, and aborts it (#193)', async () => {
  const originalFetch = globalThis.fetch;
  let aborted = false, calls = 0;
  globalThis.fetch = (_input, init) => { calls++; return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => { aborted = true; reject(new DOMException('aborted', 'AbortError')); })); };
  const service = createMarketServices({ businessSlug: slug, audience: 'customer', config: { url: 'https://offers.example.test', anonKey: 'sb_publishable_test' }, storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} }, quoteTimeoutMs: 40 });
  try {
    await assert.rejects(service.quoteOrder(lines, 'SAVE20'), (e: unknown) => e instanceof ServiceError && e.code === 'QUOTE_TIMEOUT');
    assert.equal(calls, 1); assert.equal(aborted, true, 'the hanging request is aborted, not left open');
  } finally { service.dispose(); globalThis.fetch = originalFetch; }
});
