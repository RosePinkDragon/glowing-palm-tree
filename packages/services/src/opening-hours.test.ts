import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isOpenNow } from '@market/core';
import { createMarketServices, mapOpeningHours, mapRestaurantSettingsView, OpeningHoursValidationError, OutsideHoursError, ServiceError } from './index.ts';

const jwt = (sub = 'owner', sessionId = 'session') => `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub, session_id: sessionId, role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.sig`;
const itemId = '25300000-0000-4000-8000-000000000001';
const businessRow = (hours: { opens_at: string | null; closes_at: string | null }) => ({ id: 'business', slug: 'ammu-sammu', name: 'Restaurant', contact_phone: '+912223456789', whatsapp_phone: null, delivery_fee_paise: 0, min_order_paise: 0, settings_version: 3,
  is_demo: false, ordering_enabled: true, accepting_orders: true, order_prefix: 'AMS', service_area_source: 'own', service_area_version: 'radius-12000m', service_area_verified_at: '2026-01-01T00:00:00Z', ...hours });

async function fixture(audience: 'admin' | 'customer', hours: { opens_at: string | null; closes_at: string | null } = { opens_at: '09:00:00', closes_at: '19:30:00' }) {
  const original = globalThis.fetch;
  const state = {
    hours, rpc: [] as { name: string; body: Record<string, any>; headers: Headers }[], member: true,
    rpcStatus: 200, rpcBody: undefined as unknown,
    token: jwt(),
  };
  globalThis.fetch = async (url, init) => {
    const target = new URL(String(url));
    if (target.pathname === '/auth/v1/token') return Response.json({ access_token: state.token, refresh_token: 'refresh', expires_in: 3600, token_type: 'bearer', user: { id: 'owner', aud: 'authenticated' } });
    if (target.pathname === '/auth/v1/user') return Response.json({ id: 'owner', aud: 'authenticated' });
    if (target.pathname.endsWith('/business_memberships')) return Response.json(state.member ? { role: 'admin' } : null);
    if (target.pathname.endsWith('/businesses')) return Response.json(businessRow(state.hours));
    const body = JSON.parse(String(init?.body));
    state.rpc.push({ name: target.pathname.split('/').pop()!, body, headers: new Headers(init?.headers) });
    if (state.rpcBody !== undefined) return Response.json(state.rpcBody, { status: state.rpcStatus });
    return Response.json({ opens_at: body.p_opens_at === null ? null : String(body.p_opens_at).slice(0, 5), closes_at: body.p_closes_at === null ? null : String(body.p_closes_at).slice(0, 5), settings_version: body.p_expected_version + 1 });
  };
  const service = createMarketServices({ businessSlug: 'ammu-sammu', audience, config: { url: 'https://hours.example.test', anonKey: 'sb_publishable_test' } });
  await service.auth.signIn('user@example.test', 'password');
  return { service, state, cleanup: () => { service.dispose(); globalThis.fetch = original; } };
}
const refusal = (hint: string | null) => ({ code: 'PT409', message: 'restaurant is outside its opening hours', details: 'OUTSIDE_HOURS', hint });
const cartItem = { id: itemId, businessId: 'ammu-sammu', name: 'Dish', description: '', category: 'C', categoryId: 'c', categorySortOrder: 0, diet: null, pricePaise: 10000, isAvailable: true, isDemo: false, isFeatured: false } as never;
const accepted = { lines: [{ menu_item_id: itemId, quantity: 1, unit_price_paise: 10000, line_total_paise: 10000 }], delivery_fee_paise: 0, min_order_paise: 0, subtotal_paise: 10000, total_paise: 10000 };

test('getBusiness and the settings read return the hours as HH:MM, and isOpenNow works on them', async () => {
  const { service, cleanup } = await fixture('admin');
  try {
    const business = await service.getBusiness();
    assert.deepEqual(business.openingHours, { opensAt: '09:00', closesAt: '19:30' });
    assert.equal(isOpenNow(business, new Date('2026-11-26T09:00:00+05:30')), true);
    assert.equal(isOpenNow(business, new Date('2026-11-26T19:30:00+05:30')), false);
    assert.deepEqual((await service.getRestaurantSettings()).openingHours, { opensAt: '09:00', closesAt: '19:30' });
  } finally { cleanup(); }
  const none = await fixture('customer', { opens_at: null, closes_at: null });
  try { assert.equal((await none.service.getBusiness()).openingHours, null); } finally { none.cleanup(); }
  const midnight = await fixture('customer', { opens_at: '11:00:00', closes_at: '00:00:00' });
  try { assert.deepEqual((await midnight.service.getBusiness()).openingHours, { opensAt: '11:00', closesAt: '00:00' }); } finally { midnight.cleanup(); }
  const demo = createMarketServices({ businessSlug: 'kokani-dine-inn', audience: 'customer', config: {} });
  assert.equal((await demo.getBusiness()).openingHours, null);
  demo.dispose();
});

test('mapOpeningHours is strict about what the server returns', () => {
  assert.equal(mapOpeningHours(null, null), null);
  assert.equal(mapOpeningHours(undefined, undefined), null);
  assert.deepEqual(mapOpeningHours('09:00:00', '19:30:00'), { opensAt: '09:00', closesAt: '19:30' });
  for (const [a, b] of [['09:00:00', null], [null, '19:30:00'], ['09:00:30', '19:30:00'], ['19:30:00', '09:00:00'], ['09:00:00', '09:00:00'], ['24:00:00', '00:00:00'], ['x', 'y'], [900, 1930]]) {
    assert.throws(() => mapOpeningHours(a, b), (error: unknown) => error instanceof ServiceError && error.code === 'INVALID_RESPONSE', `${a} ${b}`);
  }
  const row = { contact_phone: '+912223456789', whatsapp_phone: null, delivery_fee_paise: 0, min_order_paise: 0, settings_version: 1, order_prefix: 'AMS' };
  assert.equal(mapRestaurantSettingsView(row).openingHours, null);
  assert.deepEqual(mapRestaurantSettingsView({ ...row, opens_at: '11:00:00', closes_at: '00:00:00' }).openingHours, { opensAt: '11:00', closesAt: '00:00' });
});

test('saveOpeningHours sends normalised times and the expected version, and returns the confirmed hours', async () => {
  const { service, state, cleanup } = await fixture('admin');
  try {
    const saved = await service.saveOpeningHours({ opensAt: '11:00', closesAt: '24:00', expectedVersion: 3 });
    assert.deepEqual(saved, { openingHours: { opensAt: '11:00', closesAt: '00:00' }, version: 4 });
    assert.equal(state.rpc[0].name, 'save_opening_hours');
    assert.deepEqual(state.rpc[0].body, { p_business_slug: 'ammu-sammu', p_opens_at: '11:00', p_closes_at: '00:00', p_expected_version: 3 });
    assert.equal(state.rpc[0].headers.get('authorization'), `Bearer ${state.token}`);
    assert.deepEqual(await service.saveOpeningHours({ opensAt: null, closesAt: null, expectedVersion: 4 }), { openingHours: null, version: 5 });
    assert.deepEqual(state.rpc[1].body, { p_business_slug: 'ammu-sammu', p_opens_at: null, p_closes_at: null, p_expected_version: 4 });
  } finally { cleanup(); }
});

test('saveOpeningHours validates before any request and maps the server refusals', async () => {
  const { service, state, cleanup } = await fixture('admin');
  try {
    for (const [opensAt, closesAt, field] of [['09:00', '09:00', 'closesAt'], ['19:30', '09:00', 'closesAt'], ['9am', '19:30', 'opensAt'], ['09:00', null, 'openingHours']] as const) {
      await assert.rejects(service.saveOpeningHours({ opensAt, closesAt, expectedVersion: 3 }), (error: unknown) => error instanceof OpeningHoursValidationError && error.code === 'INVALID_SETTINGS' && Object.keys(error.fields).join() === field);
    }
    for (const expectedVersion of [0, 1.5, NaN, 2147483648]) await assert.rejects(service.saveOpeningHours({ opensAt: '09:00', closesAt: '19:30', expectedVersion }), (error: unknown) => error instanceof ServiceError && error.code === 'INVALID_SETTINGS');
    assert.equal(state.rpc.length, 0, 'nothing was sent');
    state.rpcStatus = 400;
    state.rpcBody = { code: '40001', message: 'restaurant details changed; refresh before saving' };
    await assert.rejects(service.saveOpeningHours({ opensAt: '09:00', closesAt: '19:30', expectedVersion: 3 }), (error: unknown) => error instanceof ServiceError && error.code === 'SETTINGS_CHANGED');
    state.rpcBody = { code: '42501', message: 'invalid session', details: 'INVALID_SESSION' };
    await assert.rejects(service.saveOpeningHours({ opensAt: '09:00', closesAt: '19:30', expectedVersion: 3 }), (error: unknown) => error instanceof ServiceError && error.code === 'SIGN_IN_REQUIRED');
    state.rpcBody = { code: '42501', message: 'business unavailable' };
    await assert.rejects(service.saveOpeningHours({ opensAt: '09:00', closesAt: '19:30', expectedVersion: 3 }), (error: unknown) => error instanceof ServiceError && error.code === 'ADMIN_REQUIRED');
    state.rpcBody = { code: '22023', message: 'Closing must be after opening on the same day (midnight is allowed).', details: 'closesAt' };
    await assert.rejects(service.saveOpeningHours({ opensAt: '09:00', closesAt: '19:30', expectedVersion: 3 }), (error: unknown) => error instanceof OpeningHoursValidationError && error.fields.closesAt?.startsWith('Closing must'));
    state.rpcBody = { code: '22023', message: 'odd', details: 'other' };
    await assert.rejects(service.saveOpeningHours({ opensAt: '09:00', closesAt: '19:30', expectedVersion: 3 }), (error: unknown) => error instanceof ServiceError && error.code === 'INVALID_SETTINGS' && !(error instanceof OpeningHoursValidationError));
    // A confirmation that does not match what was asked is not trusted.
    state.rpcStatus = 200;
    for (const body of [{ opens_at: '10:00', closes_at: '19:30', settings_version: 4 }, { opens_at: '09:00', closes_at: '19:30', settings_version: 9 }, null, 'x']) {
      state.rpcBody = body;
      await assert.rejects(service.saveOpeningHours({ opensAt: '09:00', closesAt: '19:30', expectedVersion: 3 }), (error: unknown) => error instanceof ServiceError && error.code === 'INVALID_RESPONSE');
    }
  } finally { cleanup(); }
  const notOwner = await fixture('admin');
  try {
    notOwner.state.member = false;
    await assert.rejects(notOwner.service.saveOpeningHours({ opensAt: '09:00', closesAt: '19:30', expectedVersion: 3 }), (error: unknown) => error instanceof ServiceError && error.code === 'ADMIN_REQUIRED');
    assert.equal(notOwner.state.rpc.length, 0);
  } finally { notOwner.cleanup(); }
  const customer = await fixture('customer');
  try {
    await assert.rejects(customer.service.saveOpeningHours({ opensAt: '09:00', closesAt: '19:30', expectedVersion: 3 }), (error: unknown) => error instanceof ServiceError && error.code === 'ADMIN_REQUIRED');
    assert.equal(customer.state.rpc.length, 0);
  } finally { customer.cleanup(); }
  const demo = createMarketServices({ businessSlug: 'ammu-sammu', audience: 'admin', config: {} });
  await assert.rejects(demo.saveOpeningHours({ opensAt: '09:00', closesAt: '19:30', expectedVersion: 3 }), (error: unknown) => error instanceof ServiceError && error.code === 'DEMO_MODE');
  demo.dispose();
});

test('quoteOrder and placeOrder map the server\'s OUTSIDE_HOURS refusal to a definite, friendly NOT_ACCEPTING_ORDERS error', async () => {
  const { service, state, cleanup } = await fixture('customer');
  try {
    state.rpcStatus = 409;
    state.rpcBody = refusal('09:00');
    const check = (error: unknown) => {
      assert.ok(error instanceof OutsideHoursError);
      assert.equal(error.code, 'NOT_ACCEPTING_ORDERS');
      assert.equal(error.reason, 'OUTSIDE_HOURS');
      assert.equal(error.opensAt, '09:00');
      assert.equal(error.opensAtLabel, '9 am');
      assert.equal(error.message, 'The restaurant is closed right now. It opens at 9 am.');
      return true;
    };
    await assert.rejects(service.quoteOrder([{ item: cartItem, quantity: 1 }]), check);
    const order = { lines: [{ item: cartItem, quantity: 1 }], savedAddress: { id: '74000000-0000-4000-8000-000000000001', version: 1 }, delivery: { name: 'N', phone: '9876543210' }, location: null, idempotencyKey: '65300000-0000-4000-8000-000000000001', pricing: accepted } as never;
    await assert.rejects(service.placeOrder(order), check);
    state.rpcBody = refusal('19:30:00');
    await assert.rejects(service.placeOrder(order), (error: unknown) => error instanceof OutsideHoursError && error.opensAt === '19:30' && error.opensAtLabel === '7:30 pm');
    state.rpcBody = refusal(null);
    await assert.rejects(service.placeOrder(order), (error: unknown) => error instanceof OutsideHoursError && error.opensAt === null && error.message === 'The restaurant is closed right now.');
    // The owner's switch keeps its own message and is not mistaken for hours.
    state.rpcBody = { code: 'PT409', message: 'restaurant is not accepting orders' };
    await assert.rejects(service.placeOrder(order), (error: unknown) => error instanceof ServiceError && !(error instanceof OutsideHoursError) && error.code === 'NOT_ACCEPTING_ORDERS' && error.message === 'The restaurant is not taking orders right now.');
  } finally { cleanup(); }
});
