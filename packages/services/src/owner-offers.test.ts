import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMarketServices, deriveOfferStatus, offerWindowOpen, OfferValidationError, OwnerOfferError, ServiceError, validateOffer, validateOfferPatch, type OfferInput } from './index.ts';

const offerId = '18200000-0000-4000-b000-0000000000b1';
const otherId = '18200000-0000-4000-b000-0000000000b2';
const jwt = () => `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: 'owner', session_id: 'session', role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.sig`;
const input: OfferInput = { name: '20% off dinner', kind: 'percent', value: 20, maxDiscountPaise: 10000, minOrderPaise: 30000, applyMode: 'code', code: 'dinner20', firstOrderOnly: true, perCustomerLimit: 2, totalLimit: 500,
  startsAt: '2026-11-21T00:00:00+05:30', endsAt: '2026-12-31T23:59:00+05:30', window: { from: '18:00', to: '22:30', days: [5, 1, 1, 3] } };
const row = (over: Record<string, unknown> = {}) => ({ id: offerId, business_id: 'business', name: 'Dinner', kind: 'percent', value: 20, max_discount_paise: 10000, min_order_paise: 30000, apply_mode: 'code', code: 'DINNER20', first_order_only: true,
  per_customer_limit: 2, total_limit: 500, starts_at: '2026-01-01T00:00:00+00:00', ends_at: null, window_from: '18:00:00', window_to: '22:30:00', window_days: [1, 3, 5], paused: false, created_at: '2026-11-20T10:00:00+00:00', version: 4, ...over });
const fields = (fn: () => unknown) => { try { fn(); } catch (e) { assert.ok(e instanceof OfferValidationError, String(e)); return Object.keys(e.fields).sort(); } assert.fail('expected a validation error'); };

test('offer validation normalises and mirrors every database check', () => {
  const ok = validateOffer(input);
  assert.equal(ok.code, 'DINNER20'); assert.deepEqual(ok.window, { from: '18:00', to: '22:30', days: [1, 3, 5] });
  assert.equal(ok.startsAt, '2026-11-20T18:30:00.000Z'); assert.equal(ok.name, '20% off dinner');
  const free: OfferInput = { ...input, kind: 'free_delivery', value: null, maxDiscountPaise: null, applyMode: 'automatic', code: null, window: null };
  assert.equal(validateOffer(free).code, null);
  // Boundaries that are allowed.
  for (const patch of [{ value: 1 }, { value: 90 }, { maxDiscountPaise: 100 }, { maxDiscountPaise: 100000 }, { minOrderPaise: 0 }, { minOrderPaise: 1000000 }, { perCustomerLimit: 1 }, { perCustomerLimit: 99 }, { totalLimit: 1 }, { totalLimit: 100000 },
    { name: 'abc' }, { name: 'x'.repeat(40) }, { code: 'ABCD' }, { code: 'a1b2c3d4e5f6g7h' }, { perCustomerLimit: null, totalLimit: null, startsAt: null, endsAt: null, window: null, maxDiscountPaise: null }]) assert.ok(validateOffer({ ...input, ...patch }), JSON.stringify(patch));
  assert.equal(validateOffer({ ...input, kind: 'flat', value: 100, maxDiscountPaise: null }).value, 100); assert.equal(validateOffer({ ...input, kind: 'flat', value: 100000, maxDiscountPaise: null }).value, 100000);
  // Each rule, one field at a time.
  const bad: [Partial<OfferInput>, string[]][] = [
    [{ name: 'ab' }, ['name']], [{ name: 'x'.repeat(41) }, ['name']], [{ name: '   ' }, ['name']], [{ name: 'tab\there' }, ['name']],
    [{ value: 0 }, ['value']], [{ value: 91 }, ['value']], [{ value: 10.5 }, ['value']], [{ value: null }, ['value']],
    [{ kind: 'flat', value: 99, maxDiscountPaise: null }, ['value']], [{ kind: 'flat', value: 100001, maxDiscountPaise: null }, ['value']],
    [{ kind: 'free_delivery', value: 5, maxDiscountPaise: null }, ['value']], [{ kind: 'bogo' as never, maxDiscountPaise: null }, ['kind']],
    [{ maxDiscountPaise: 99 }, ['maxDiscount']], [{ maxDiscountPaise: 100001 }, ['maxDiscount']], [{ kind: 'flat', value: 5000 }, ['maxDiscount']],
    [{ minOrderPaise: -1 }, ['minOrder']], [{ minOrderPaise: 1000001 }, ['minOrder']], [{ minOrderPaise: 1.5 }, ['minOrder']],
    [{ code: 'ABC' }, ['code']], [{ code: 'A'.repeat(16) }, ['code']], [{ code: 'AB-CD' }, ['code']], [{ code: null }, ['code']], [{ applyMode: 'automatic' }, ['code']], [{ applyMode: 'maybe' as never }, ['applyMode']],
    [{ perCustomerLimit: 0 }, ['perCustomerLimit']], [{ perCustomerLimit: 100 }, ['perCustomerLimit']], [{ totalLimit: 0 }, ['totalLimit']], [{ totalLimit: 100001 }, ['totalLimit']],
    [{ startsAt: 'soon' }, ['startsAt']], [{ endsAt: 'later' }, ['endsAt']], [{ endsAt: input.startsAt }, ['endsAt']], [{ endsAt: '2026-11-20T00:00:00+05:30' }, ['endsAt']],
    [{ window: { from: '18:00', to: '18:00', days: [1] } }, ['window']], [{ window: { from: '18:00', to: '22:30', days: [] } }, ['window']], [{ window: { from: '18:00', to: '22:30', days: [0] } }, ['window']],
    [{ window: { from: '18:00', to: '22:30', days: [8] } }, ['window']], [{ window: { from: '24:00', to: '22:30', days: [1] } }, ['window']], [{ window: { from: '6pm', to: '22:30', days: [1] } }, ['window']],
  ];
  for (const [patch, expected] of bad) assert.deepEqual(fields(() => validateOffer({ ...input, ...patch })), expected, JSON.stringify(patch));
  assert.deepEqual(fields(() => validateOffer({ ...input, name: '', value: 0, minOrderPaise: -5, code: null })), ['code', 'minOrder', 'name', 'value'], 'every invalid field is reported');
  assert.ok(validateOffer({ ...input, window: { from: '22:00', to: '02:00', days: [5, 6] } }), 'a window past midnight is allowed');
});

test('a patch is every term or only the name and end date', () => {
  assert.deepEqual(validateOfferPatch({ name: '  New name  ' }), { name: 'New name' });
  assert.deepEqual(validateOfferPatch({ endsAt: '2026-12-01T00:00:00Z' }), { endsAt: '2026-12-01T00:00:00.000Z' });
  assert.deepEqual(validateOfferPatch({ endsAt: null }), { endsAt: null });
  assert.deepEqual(fields(() => validateOfferPatch({ name: 'x' })), ['name']);
  assert.deepEqual(fields(() => validateOfferPatch({ endsAt: 'nope' })), ['endsAt']);
  assert.deepEqual(fields(() => validateOfferPatch({})), ['name']);
  assert.deepEqual(fields(() => validateOfferPatch({ name: 'Fine name', value: 3 } as never)), ['applyMode', 'endsAt', 'kind', 'maxDiscount', 'minOrder', 'perCustomerLimit', 'startsAt', 'totalLimit', 'window'], 'terms must come as a complete set');
  assert.equal((validateOfferPatch(input) as OfferInput).code, 'DINNER20');
});

test('status is derived: ended, used up, paused, scheduled, active', () => {
  const now = new Date('2026-11-20T12:00:00Z');
  const o = { paused: false, startsAt: null as string | null, endsAt: null as string | null, totalLimit: null as number | null };
  assert.equal(deriveOfferStatus(o, 0, now), 'active');
  assert.equal(deriveOfferStatus({ ...o, startsAt: '2026-11-20T12:00:01Z' }, 0, now), 'scheduled');
  assert.equal(deriveOfferStatus({ ...o, startsAt: '2026-11-20T12:00:00Z' }, 0, now), 'active', 'a start at this instant has started');
  assert.equal(deriveOfferStatus({ ...o, paused: true }, 0, now), 'paused');
  assert.equal(deriveOfferStatus({ ...o, endsAt: '2026-11-20T12:00:00Z' }, 0, now), 'ended', 'the end instant has ended, like the database');
  assert.equal(deriveOfferStatus({ ...o, endsAt: '2026-11-21T00:00:00Z' }, 0, now), 'active');
  assert.equal(deriveOfferStatus({ ...o, totalLimit: 3 }, 3, now), 'used_up'); assert.equal(deriveOfferStatus({ ...o, totalLimit: 3 }, 2, now), 'active');
  assert.equal(deriveOfferStatus({ ...o, totalLimit: 3, paused: true }, 3, now), 'used_up'); assert.equal(deriveOfferStatus({ ...o, totalLimit: 3, endsAt: '2026-01-01T00:00:00Z' }, 3, now), 'ended');
  assert.equal(deriveOfferStatus({ ...o, paused: true, endsAt: '2026-01-01T00:00:00Z' }, 0, now), 'ended');
});

type Req = { method: string; path: string; query: URL['searchParams']; body: unknown; accept: string };
async function fixture(slug: 'ammu-sammu' | 'kokani-dine-inn' = 'ammu-sammu') {
  const original = globalThis.fetch;
  const state = {
    requests: [] as Req[], offers: [row()] as Record<string, unknown>[], redemptions: [] as { id: string; offer_id: string; orders: { status: string; discount_paise: number } }[],
    /** Answers for the next write(s): consumed in order. */
    writes: [] as (() => Response)[], member: true, gone: false, statsFail: false, endless: false, dayOrders: [] as { id: string; offer_id: string; offer_name: string; offer_code: string | null; offer_kind: string; discount_paise: number }[],
  };
  globalThis.fetch = async (url, init) => {
    const target = new URL(String(url));
    if (target.pathname === '/auth/v1/token') return Response.json({ access_token: jwt(), refresh_token: 'refresh', expires_in: 3600, token_type: 'bearer', user: { id: 'owner', aud: 'authenticated' } });
    if (target.pathname === '/auth/v1/user') return Response.json({ id: 'owner', aud: 'authenticated' });
    if (target.pathname.endsWith('/business_memberships')) return Response.json(state.member ? { role: 'admin' } : null);
    if (target.pathname.endsWith('/businesses')) return Response.json({ id: 'business', slug, name: 'Restaurant', delivery_fee_paise: 3000, min_order_paise: 0, is_demo: false, ordering_enabled: true, accepting_orders: true });
    const method = String(init?.method ?? 'GET'), headers = new Headers(init?.headers);
    const req: Req = { method, path: target.pathname.split('/').pop()!, query: target.searchParams, body: init?.body ? JSON.parse(String(init.body)) : undefined, accept: headers.get('accept') ?? '' };
    state.requests.push(req);
    assert.notEqual(method, 'DELETE', 'offers are never deleted');
    if (req.path === 'offer_usage_stats') {
      if (state.statsFail) return Response.json({ code: 'XX000', message: 'boom', details: null, hint: null }, { status: 500 });
      const offer = (req.body as { p_offer_id: string | null }).p_offer_id;
      const groups = new Map<string, { offer_id: string; uses: number; discount_given_paise: number; any_redemption: boolean }>();
      for (const r of state.redemptions.filter(r => !offer || r.offer_id === offer)) {
        const group = groups.get(r.offer_id) ?? { offer_id: r.offer_id, uses: 0, discount_given_paise: 0, any_redemption: true };
        if (r.orders.status !== 'cancelled') { group.uses++; group.discount_given_paise += r.orders.discount_paise; }
        groups.set(r.offer_id, group);
      }
      return Response.json([...groups.values()]);
    }
    if (req.path === 'orders') { const after = target.searchParams.get('id')?.replace('gt.', ''); return Response.json(state.dayOrders.filter(o => !after || o.id > after).sort((a, b) => a.id.localeCompare(b.id)).slice(0, Number(target.searchParams.get('limit')))); }
    assert.equal(req.path, 'offers');
    if (method === 'GET' && target.searchParams.get('select') === 'id') return Response.json(state.gone ? null : { id: offerId });
    if (method === 'GET') return Response.json(state.offers);
    const next = state.writes.shift();
    if (next) return next();
    return Response.json(method === 'POST' ? row({ ...(req.body as object), id: offerId, version: 1, created_at: '2026-11-20T10:00:00+00:00' }) : [row({ ...(req.body as object), version: 5 })], { status: method === 'POST' ? 201 : 200 });
  };
  const service = createMarketServices({ businessSlug: slug, audience: 'admin', config: { url: 'https://offers-owner.example.test', anonKey: 'sb_publishable_test' } });
  await service.auth.signIn('owner@example.test', 'password');
  return { service, state, cleanup: () => { service.dispose(); globalThis.fetch = original; }, writes: () => state.requests.filter(r => r.path === 'offers' && r.method !== 'GET') };
}
const dbError = (status: number, code: string, message: string, details: string | null = null) => () => Response.json({ code, message, details, hint: null }, { status });
const rejects = (promise: Promise<unknown>, code: string) => assert.rejects(promise, (e: unknown) => e instanceof ServiceError && e.code === code && !e.message.includes('relation'));

test('listOffers derives status and totals from redemptions on non-cancelled orders', async () => {
  const { service, state, cleanup } = await fixture('kokani-dine-inn');
  try {
    state.offers = [row(), row({ id: otherId, name: 'Free delivery', kind: 'free_delivery', value: null, max_discount_paise: null, min_order_paise: 0, apply_mode: 'automatic', code: null, total_limit: 2, window_from: null, window_to: null, window_days: null, starts_at: null }),
      row({ id: '18200000-0000-4000-b000-0000000000b3', name: 'Later', paused: true, starts_at: '2099-01-01T00:00:00+00:00' })];
    state.redemptions = [
      { id: 'r1', offer_id: offerId, orders: { status: 'delivered', discount_paise: 6000 } }, { id: 'r2', offer_id: offerId, orders: { status: 'placed', discount_paise: 4000 } }, { id: 'r3', offer_id: offerId, orders: { status: 'cancelled', discount_paise: 9000 } },
      { id: 'r4', offer_id: otherId, orders: { status: 'cancelled', discount_paise: 3000 } },
      { id: 'r5', offer_id: otherId, orders: { status: 'delivered', discount_paise: 3000 } }, { id: 'r6', offer_id: otherId, orders: { status: 'delivered', discount_paise: 3000 } },
    ];
    const offers = await service.listOffers();
    const [dinner, free, later] = offers;
    assert.deepEqual([dinner.useCount, dinner.discountGivenPaise, dinner.termsLocked, dinner.status], [2, 10000, true, 'active'], 'a cancelled order gives its use and amount back');
    assert.deepEqual([free.useCount, free.discountGivenPaise, free.termsLocked, free.status], [2, 6000, true, 'used_up']);
    assert.deepEqual([later.useCount, later.termsLocked, later.status], [0, false, 'paused'], 'paused wins over scheduled');
    assert.equal(dinner.code, 'DINNER20'); assert.deepEqual(dinner.window, { from: '18:00', to: '22:30', days: [1, 3, 5] }); assert.equal(dinner.startsAt, '2026-01-01T00:00:00.000Z');
    const [read, usage] = state.requests;
    assert.equal(read.query.get('business_id'), 'eq.business'); assert.equal(usage.path, 'offer_usage_stats'); assert.deepEqual(usage.body, { p_business_id: 'business', p_offer_id: null });
  } finally { cleanup(); }
});

test('listOffers refuses a non-owner and a malformed row', async () => {
  const { service, state, cleanup } = await fixture();
  try {
    state.member = false;
    await rejects(service.listOffers(), 'ADMIN_REQUIRED');
    state.member = true; state.offers = [row({ kind: 'bogo' })];
    await rejects(service.listOffers(), 'INVALID_RESPONSE');
    state.offers = [row({ version: 0 })];
    await rejects(service.listOffers(), 'INVALID_RESPONSE');
  } finally { cleanup(); }
});

test('createOffer sends one validated insert for this restaurant and never an invalid one', async () => {
  for (const slug of ['ammu-sammu', 'kokani-dine-inn'] as const) {
    const { service, state, cleanup, writes } = await fixture(slug);
    try {
      await assert.rejects(service.createOffer({ ...input, value: 95 }), OfferValidationError);
      assert.equal(writes().length, 0, 'nothing is sent while a field is invalid');
      const created = await service.createOffer(input);
      assert.equal(created.id, offerId); assert.equal(created.version, 1);
      const [write] = writes();
      assert.equal(writes().length, 1); assert.equal(write.method, 'POST'); assert.match(write.accept, /pgrst\.object/);
      assert.deepEqual(write.body, { business_id: 'business', name: '20% off dinner', kind: 'percent', value: 20, max_discount_paise: 10000, min_order_paise: 30000, apply_mode: 'code', code: 'DINNER20', first_order_only: true, per_customer_limit: 2,
        total_limit: 500, starts_at: '2026-11-20T18:30:00.000Z', ends_at: '2026-12-31T18:29:00.000Z', window_from: '18:00', window_to: '22:30', window_days: [1, 3, 5], paused: false });
      assert.equal(state.requests.filter(r => r.method === 'POST').length, 1);
    } finally { cleanup(); }
  }
});

test('database errors become typed errors with stable codes', async () => {
  const { service, state, cleanup } = await fixture();
  try {
    // A check violation becomes a field error, from the constraint named by the server.
    state.writes.push(dbError(400, '23514', 'new row for relation "offers" violates check constraint "offer_max_discount_valid"'));
    await assert.rejects(service.createOffer(input), (e: unknown) => e instanceof OfferValidationError && e.code === 'INVALID_OFFER' && Object.keys(e.fields).join() === 'maxDiscount' && !String(e.fields.maxDiscount).includes('violates'));
    state.writes.push(dbError(400, '23514', 'new row violates check constraint "offer_dates_valid"'));
    await assert.rejects(service.createOffer(input), (e: unknown) => e instanceof OfferValidationError && 'endsAt' in e.fields);
    state.writes.push(dbError(400, '23514', 'new row violates check constraint "something_new"'));
    await rejects(service.createOffer(input), 'INVALID_OFFER');
    // A duplicate code.
    state.writes.push(dbError(409, '23505', 'code is already in use by another active or scheduled offer'));
    await assert.rejects(service.createOffer(input), (e: unknown) => e instanceof OwnerOfferError && e.code === 'OFFER_CODE_TAKEN');
    // Terms locked once used.
    state.writes.push(dbError(409, 'PT409', 'offer terms are locked once it has been used', 'OFFER_LOCKED'));
    await assert.rejects(service.updateOffer(offerId, 4, input), (e: unknown) => e instanceof OwnerOfferError && e.code === 'OFFER_LOCKED' && e.message.startsWith('Terms are locked once an offer has been used.'));
    // Another PT409 is not mistaken for a lock.
    state.writes.push(dbError(409, 'PT409', 'something else', 'NOT_ACCEPTING_ORDERS'));
    await rejects(service.updateOffer(offerId, 4, input), 'PT409');
    state.writes.push(dbError(403, '42501', 'permission denied'));
    await rejects(service.pauseOffer(offerId, 4), 'ADMIN_REQUIRED');
  } finally { cleanup(); }
});

test('updateOffer is guarded by the loaded version: stale and missing are different errors', async () => {
  const { service, state, cleanup, writes } = await fixture();
  try {
    state.writes.push(() => Response.json([]));
    await assert.rejects(service.updateOffer(offerId, 3, { name: 'Renamed' }), (e: unknown) => e instanceof OwnerOfferError && e.code === 'OFFER_STALE');
    const [write] = writes();
    assert.equal(write.method, 'PATCH'); assert.equal(write.query.get('id'), `eq.${offerId}`); assert.equal(write.query.get('version'), 'eq.3'); assert.equal(write.query.get('business_id'), 'eq.business');
    assert.deepEqual(write.body, { name: 'Renamed' }, 'only the name was sent');
    state.gone = true; state.writes.push(() => Response.json([]));
    await assert.rejects(service.updateOffer(offerId, 3, { name: 'Renamed' }), (e: unknown) => e instanceof OwnerOfferError && e.code === 'OFFER_MISSING');
    state.gone = false;
    const saved = await service.updateOffer(offerId, 4, { name: 'Renamed too', endsAt: null });
    assert.equal(saved.version, 5); assert.deepEqual(writes()[2].body, { name: 'Renamed too', ends_at: null });
    // A full patch sends every term column; bad ids and versions never reach the network.
    await service.updateOffer(offerId, 5, input);
    assert.equal((writes()[3].body as Record<string, unknown>).code, 'DINNER20');
    const before = writes().length;
    await assert.rejects(service.updateOffer('nope', 1, { name: 'Fine name' }), OfferValidationError);
    await assert.rejects(service.updateOffer(offerId, 0, { name: 'Fine name' }), OfferValidationError);
    await assert.rejects(service.pauseOffer(offerId, 1.5), OfferValidationError);
    assert.equal(writes().length, before);
    // More than one row back is refused rather than trusted.
    state.writes.push(() => Response.json([row(), row({ id: otherId })]));
    await rejects(service.pauseOffer(offerId, 4), 'INVALID_RESPONSE');
  } finally { cleanup(); }
});

test('pause, resume and end each change one offer in one statement', async () => {
  const { service, state, cleanup, writes } = await fixture();
  try {
    state.writes.push(() => Response.json([row({ paused: true, version: 5 })]));
    assert.equal((await service.pauseOffer(offerId, 4)).status, 'paused');
    state.writes.push(() => Response.json([row({ paused: false, version: 6 })]));
    assert.equal((await service.resumeOffer(offerId, 5)).status, 'active');
    state.writes.push(() => Response.json([row({ ends_at: '2026-11-01T12:00:00+00:00', version: 7 })]));
    assert.equal((await service.endOffer(offerId, 6)).status, 'ended');
    assert.deepEqual(writes().map(w => w.body), [{ paused: true }, { paused: false }, { ends_at: 'now' }], 'ending uses the database clock');
    assert.deepEqual(writes().map(w => w.query.get('version')), ['eq.4', 'eq.5', 'eq.6']);
    assert.ok(writes().every(w => w.method === 'PATCH' && w.query.get('id') === `eq.${offerId}`), 'each statement names exactly one offer');
    assert.equal('deleteOffer' in service, false, 'offers are never deleted');
    // An offer that has not started cannot end before its start: it is ended before it began.
    state.writes.push(dbError(400, '23514', 'new row violates check constraint "offer_dates_valid"'));
    state.writes.push(() => Response.json([row({ starts_at: null, ends_at: '2026-11-01T12:00:00+00:00', version: 8 })]));
    assert.equal((await service.endOffer(offerId, 7)).status, 'ended');
    assert.deepEqual(writes().slice(3).map(w => w.body), [{ ends_at: 'now' }, { ends_at: 'now', starts_at: null }]);
  } finally { cleanup(); }
});

test('a write retries once on a deadlock or serialization failure, never more', async () => {
  for (const code of ['40P01', '40001']) {
    const { service, state, cleanup, writes } = await fixture();
    try {
      state.writes.push(dbError(409, code, 'deadlock detected'));
      assert.equal((await service.pauseOffer(offerId, 4)).version, 5);
      assert.equal(writes().length, 2, `${code}: retried exactly once`);
      state.writes.push(dbError(409, code, 'deadlock detected'), dbError(409, code, 'deadlock detected'));
      await rejects(service.pauseOffer(offerId, 4), code);
      assert.equal(writes().length, 4, 'the second failure is reported, not retried again');
      state.writes.push(dbError(409, code, 'deadlock detected'));
      await service.createOffer(input);
      assert.equal(writes().filter(w => w.method === 'POST').length, 2, 'an insert retries too');
    } finally { cleanup(); }
  }
});

test('a committed write is never reported as failed because the usage read-back failed', async () => {
  const { service, state, cleanup, writes } = await fixture();
  try {
    state.statsFail = true;
    const created = await service.createOffer(input);
    assert.deepEqual([created.id, created.useCount, created.termsLocked, created.usageKnown], [offerId, 0, false, true], 'a new offer has no usage to read');
    assert.equal(state.requests.filter(r => r.path === 'offer_usage_stats').length, 0, 'create reads nothing back');
    state.writes.push(() => Response.json([row({ paused: true, version: 5 })]));
    const paused = await service.pauseOffer(offerId, 4);
    assert.deepEqual([paused.status, paused.version, paused.usageKnown, paused.termsLocked], ['paused', 5, false, false], 'the write resolves; usage is simply unknown');
    state.writes.push(() => Response.json([row({ ends_at: '2026-11-01T12:00:00+00:00', version: 6 })]));
    assert.equal((await service.endOffer(offerId, 5)).status, 'ended');
    state.writes.push(() => Response.json([row({ name: 'Renamed', version: 7 })]));
    assert.equal((await service.updateOffer(offerId, 6, { name: 'Renamed' })).name, 'Renamed');
    assert.equal(writes().length, 4);
  } finally { cleanup(); }
});

test('listOffers still lists offers, without usage, when usage cannot be read', async () => {
  const { service, state, cleanup } = await fixture();
  try {
    state.statsFail = true;
    let [offer] = await service.listOffers();
    assert.deepEqual([offer.name, offer.usageKnown, offer.useCount, offer.discountGivenPaise, offer.termsLocked, offer.status], ['Dinner', false, 0, 0, false, 'active']);
    state.statsFail = false;
    [offer] = await service.listOffers();
    assert.equal(offer.usageKnown, true);
    // A failed offers read is still an error: there is nothing to show.
    state.member = false;
    await rejects(service.listOffers(), 'ADMIN_REQUIRED');
  } finally { cleanup(); }
});

test('getDayOffers totals a day from the orders\' own offer snapshots, and lists running offers only for today', async () => {
  const { service, state, cleanup } = await fixture();
  try {
    const day = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
    const o = (id: string, offer: string, name: string, code: string | null, kind: string, discount: number) => ({ id, offer_id: offer, offer_name: name, offer_code: code, offer_kind: kind, discount_paise: discount });
    state.dayOrders = [o('o1', offerId, 'Old name', 'DINNER20', 'percent', 10000), o('o2', offerId, 'Old name', 'DINNER20', 'percent', 6000), o('o3', otherId, 'Free delivery', null, 'free_delivery', 3000)];
    state.offers = [row(), row({ id: otherId, name: 'Free delivery' }), row({ id: '18200000-0000-4000-b000-0000000000b3', name: 'Quiet one' }), row({ id: '18200000-0000-4000-b000-0000000000b4', name: 'Paused one', paused: true })];
    const today = await service.getDayOffers(day);
    assert.deepEqual(today.used.map(u => [u.name, u.code, u.uses, u.givenPaise]), [['Old name', 'DINNER20', 2, 16000], ['Free delivery', null, 1, 3000]], 'the snapshot name is used, biggest first');
    assert.deepEqual([today.orderCount, today.totalGivenPaise], [3, 19000]);
    assert.deepEqual(today.running?.map(r => r.name), ['Quiet one'], 'active offers with no use today; used and paused ones are not listed as running');
    const read = state.requests.find(r => r.path === 'orders')!;
    assert.equal(read.query.get('business_id'), 'eq.business'); assert.equal(read.query.get('status'), 'neq.cancelled'); assert.equal(read.query.get('offer_id'), 'not.is.null');
    assert.deepEqual([read.query.getAll('created_at')[0], read.query.getAll('created_at')[1]], [`gte.${new Date(Date.parse(day + 'T00:00:00Z') - 330 * 60000).toISOString()}`, `lt.${new Date(Date.parse(day + 'T00:00:00Z') - 330 * 60000 + 86400000).toISOString()}`], 'the day is an India-time day');
    const past = await service.getDayOffers('2026-01-05');
    assert.deepEqual([past.running, past.used.length], [[], 2]);
    state.dayOrders = [];
    assert.deepEqual((await service.getDayOffers('2026-01-05')).used, []);
    await assert.rejects(service.getDayOffers('2026-02-30'), (e: unknown) => e instanceof ServiceError && e.code === 'INVALID_DATE');
  } finally { cleanup(); }
});

test('Today lists an offer as running only when it honestly is: used-up, out-of-window and unchecked offers are not', async () => {
  const { service, state, cleanup } = await fixture();
  try {
    const day = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
    const clock = (offsetMinutes: number) => { const t = new Date(Date.now() + 330 * 60000 + offsetMinutes * 60000); return `${String(t.getUTCHours()).padStart(2, '0')}:${String(t.getUTCMinutes()).padStart(2, '0')}:00`; };
    const id = (n: number) => `18200000-0000-4000-b000-0000000001${String(n).padStart(2, '0')}`;
    const all = [1, 2, 3, 4, 5, 6, 7];
    state.offers = [
      row({ id: id(1), name: 'Plain', total_limit: null, window_from: null, window_to: null, window_days: null }),
      row({ id: id(2), name: 'Used up', total_limit: 1, window_from: null, window_to: null, window_days: null }),
      row({ id: id(3), name: 'Some left', total_limit: 5, window_from: null, window_to: null, window_days: null }),
      row({ id: id(4), name: 'In window', total_limit: null, window_from: clock(-60), window_to: clock(60), window_days: all }),
      row({ id: id(5), name: 'Later today', total_limit: null, window_from: clock(180), window_to: clock(240), window_days: all }),
      row({ id: id(6), name: 'Cancelled use', total_limit: 1, window_from: null, window_to: null, window_days: null }),
    ];
    state.redemptions = [{ id: 'u1', offer_id: id(2), orders: { status: 'delivered', discount_paise: 100 } }, { id: 'u2', offer_id: id(6), orders: { status: 'cancelled', discount_paise: 100 } }, { id: 'u3', offer_id: id(3), orders: { status: 'placed', discount_paise: 100 } }];
    let { running } = await service.getDayOffers(day);
    assert.deepEqual(running?.map(r => [r.name, r.state]), [['Plain', 'running'], ['Some left', 'running'], ['In window', 'running'], ['Later today', 'outside_window'], ['Cancelled use', 'running']], 'used up is dropped; a cancelled order gave its use back');
    assert.deepEqual(running?.find(r => r.name === 'Later today')?.window, { from: clock(180).slice(0, 5), to: clock(240).slice(0, 5), days: all });
    // Usage that cannot be read is not guessed: limited offers are no longer called running.
    state.statsFail = true;
    ({ running } = await service.getDayOffers(day));
    assert.deepEqual(running?.map(r => [r.name, r.state]), [['Plain', 'running'], ['Some left', 'unconfirmed'], ['In window', 'running'], ['Later today', 'outside_window'], ['Used up', 'unconfirmed'], ['Cancelled use', 'unconfirmed']].sort((a, b) => ['Plain', 'Used up', 'Some left', 'In window', 'Later today', 'Cancelled use'].indexOf(a[0]!) - ['Plain', 'Used up', 'Some left', 'In window', 'Later today', 'Cancelled use'].indexOf(b[0]!)));
  } finally { cleanup(); }
});

test('the daily window is evaluated in India time, past midnight included', () => {
  const at = (iso: string) => new Date(iso); // 2026-11-23 is a Monday in India
  const evening = { from: '18:00', to: '22:30', days: [1] };
  assert.equal(offerWindowOpen(null, at('2026-11-23T00:00:00Z')), true);
  assert.equal(offerWindowOpen(evening, at('2026-11-23T12:30:00Z')), true, '18:00 IST Monday'); assert.equal(offerWindowOpen(evening, at('2026-11-23T12:29:00Z')), false);
  assert.equal(offerWindowOpen(evening, at('2026-11-23T17:00:00Z')), false, '22:30 IST is the end'); assert.equal(offerWindowOpen(evening, at('2026-11-24T12:30:00Z')), false, 'Tuesday is not a window day');
  const late = { from: '22:00', to: '02:00', days: [1] };
  assert.equal(offerWindowOpen(late, at('2026-11-23T17:00:00Z')), true, '22:30 IST Monday'); assert.equal(offerWindowOpen(late, at('2026-11-23T20:00:00Z')), true, '01:30 IST Tuesday still belongs to Monday');
  assert.equal(offerWindowOpen(late, at('2026-11-23T21:00:00Z')), false, '02:30 IST Tuesday'); assert.equal(offerWindowOpen(late, at('2026-11-23T05:00:00Z')), false, '10:30 IST Monday');
});
