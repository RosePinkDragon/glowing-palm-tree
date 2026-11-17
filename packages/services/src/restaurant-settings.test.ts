import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMarketServices, mapRestaurantSettingsView, restaurantAmountPaise, RestaurantSettingsValidationError, ServiceError, validateRestaurantSettings, type SaveRestaurantSettingsInput } from './index.ts';

const input: SaveRestaurantSettingsInput = { contactPhone: '022 2345 6789', whatsappPhone: '9876543210', deliveryFeePaise: 1234, minOrderPaise: 45678, expectedVersion: 3 };
test('settings validation normalizes Indian phones and reports every invalid field', () => {
  assert.deepEqual(validateRestaurantSettings(input), { ...input, contactPhone: '+912223456789', whatsappPhone: '+919876543210' });
  assert.equal(validateRestaurantSettings({ ...input, contactPhone: '+91 (22) 2345-6789', whatsappPhone: ' ' }).whatsappPhone, null);
  assert.equal(validateRestaurantSettings({ ...input, contactPhone: '912223456789', whatsappPhone: null }).contactPhone, '+912223456789');
  assert.throws(() => validateRestaurantSettings({ contactPhone: '+12025550123', whatsappPhone: '2223456789', deliveryFeePaise: 100001, minOrderPaise: 0.1, expectedVersion: 0 }), (error: unknown) => {
    assert.ok(error instanceof RestaurantSettingsValidationError);
    assert.deepEqual(Object.keys(error.fields).sort(), ['contactPhone', 'deliveryFeePaise', 'expectedVersion', 'minOrderPaise', 'whatsappPhone']);
    return true;
  });
  for (const field of ['deliveryFeePaise', 'minOrderPaise'] as const) for (const value of [-1, NaN, Infinity, 0.001]) {
    assert.throws(() => validateRestaurantSettings({ ...input, [field]: value }), RestaurantSettingsValidationError);
  }
  assert.equal(validateRestaurantSettings({ ...input, deliveryFeePaise: 100000, minOrderPaise: 1000000 }).minOrderPaise, 1000000);
  assert.equal(validateRestaurantSettings({ ...input, deliveryFeePaise: 0, minOrderPaise: 0 }).deliveryFeePaise, 0);
});
test('rupee conversion preserves exact paise and rejects rounding, non-decimal and excessive amounts', () => {
  for (const [value, paise] of [['0', 0], ['0.01', 1], ['12.3', 1230], ['999.99', 99999], ['1000.00', 100000]] as const) assert.equal(restaurantAmountPaise(value, 'deliveryFeePaise'), paise);
  assert.equal(restaurantAmountPaise('10000.00', 'minOrderPaise'), 1000000);
  for (const value of ['-1', '1e2', '0x10', '1.001', '', 'NaN', 'Infinity', '1,000', '1000.01']) assert.throws(() => restaurantAmountPaise(value, 'deliveryFeePaise'), RestaurantSettingsValidationError);
  assert.throws(() => restaurantAmountPaise('10000.01', 'minOrderPaise'), RestaurantSettingsValidationError);
});

const jwt = (sub = 'owner', sessionId = 'session') => `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub, session_id: sessionId, role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.sig`;
const businessRow = { id: 'business', slug: 'ammu-sammu', name: 'Restaurant', contact_phone: '+912223456789', whatsapp_phone: '+919876543210', delivery_fee_paise: 1234, min_order_paise: 45678, settings_version: 3, order_prefix: 'AMS', service_area_source: 'owner survey', service_area_version: 'radius-12000m', service_area_verified_at: '2026-11-10T00:00:00Z', accepting_orders: true, ordering_enabled: true, is_demo: false };
async function fixture(slug: 'ammu-sammu' | 'kokani-dine-inn' = 'ammu-sammu', audience: 'admin' | 'customer' = 'admin') {
  const original = globalThis.fetch;
  const state = {
    selects: [] as string[],
    calls: [] as { url: URL; headers: Headers; body: Record<string, unknown> }[],
    error: null as { code: string; message: string; details?: string } | null,
    result: undefined as unknown,
    member: true,
    onMembership: undefined as (() => Promise<void>) | undefined,
    userId: 'owner', token: jwt(),
  };
  globalThis.fetch = async (url, init) => {
    const target = new URL(String(url));
    if (target.pathname === '/auth/v1/token') return Response.json({ access_token: state.token, refresh_token: 'refresh', expires_in: 3600, token_type: 'bearer', user: { id: state.userId, aud: 'authenticated' } });
    if (target.pathname === '/auth/v1/user') return Response.json({ id: state.userId, aud: 'authenticated' });
    if (target.pathname.endsWith('/business_memberships')) {
      await state.onMembership?.();
      return Response.json(state.member ? { role: 'admin' } : null);
    }
    if (target.pathname.endsWith('/businesses')) {
      if (target.searchParams.has('slug')) assert.equal(target.searchParams.get('slug'), `eq.${slug}`);
      else assert.equal(target.searchParams.get('id'), 'eq.business');
      state.selects.push(target.searchParams.get('select') ?? '');
      return Response.json({ ...businessRow, slug });
    }
    assert.equal(target.pathname, '/rest/v1/rpc/save_restaurant_settings');
    const body = JSON.parse(String(init?.body));
    state.calls.push({ url: target, headers: new Headers(init?.headers), body });
    if (state.error) return Response.json(state.error, { status: 400 });
    return Response.json(state.result === undefined ? {
      contact_phone: body.p_contact_phone, whatsapp_phone: body.p_whatsapp_phone,
      delivery_fee_paise: body.p_delivery_fee_paise, min_order_paise: body.p_min_order_paise, settings_version: Number(body.p_expected_version) + 1,
    } : state.result);
  };
  const service = createMarketServices({ businessSlug: slug, audience, config: { url: 'https://settings.example.test', anonKey: 'sb_publishable_test' } });
  await service.auth.signIn('owner@example.test', 'password');
  return { service, state, cleanup: () => { service.dispose(); globalThis.fetch = original; } };
}
test('both restaurants read public updated terms and save only four normalized fields plus expected version', async () => {
  for (const slug of ['ammu-sammu', 'kokani-dine-inn'] as const) {
    const { service, state, cleanup } = await fixture(slug);
    try {
      const business = await service.getBusiness();
      assert.equal(business.whatsappPhone, businessRow.whatsapp_phone);
      assert.equal(business.settingsVersion, 3);
      const read = await service.getRestaurantSettings();
      assert.equal(read.contactPhone, businessRow.contact_phone); assert.equal(read.orderPrefix, 'AMS'); assert.deepEqual(read.deliveryArea, { kind: 'radius', radiusM: 12000 });
      assert.ok(state.selects.some(select => select.includes('order_prefix') && select.includes('service_area_version')) && state.selects.every(select => !/(^|,)service_area(,|$)|kitchen_location/.test(select)), 'the polygon is never requested');
            const saved = await service.saveRestaurantSettings({ ...input, acceptingOrders: false, orderPrefix: 'HACK' } as SaveRestaurantSettingsInput);
      assert.deepEqual(saved, { contactPhone: '+912223456789', whatsappPhone: '+919876543210', deliveryFeePaise: 1234, minOrderPaise: 45678, version: 4 });
      assert.deepEqual(state.calls[0].body, { p_business_slug: slug, p_contact_phone: '+912223456789', p_whatsapp_phone: '+919876543210', p_delivery_fee_paise: 1234, p_min_order_paise: 45678, p_expected_version: 3 });
      assert.equal(state.calls[0].headers.get('authorization'), `Bearer ${state.token}`);
    } finally { cleanup(); }
  }
});
test('settings services reject invalid input, non-owners, customer audience and demo writes', async () => {
  const owner = await fixture();
  try {
    await assert.rejects(owner.service.saveRestaurantSettings({ ...input, deliveryFeePaise: 0.1 }), RestaurantSettingsValidationError);
    owner.state.member = false;
    await assert.rejects(owner.service.saveRestaurantSettings(input), (error: unknown) => error instanceof ServiceError && error.code === 'ADMIN_REQUIRED');
    assert.equal(owner.state.calls.length, 0);
  } finally { owner.cleanup(); }
  const customer = await fixture('ammu-sammu', 'customer');
  try {
    await assert.rejects(customer.service.saveRestaurantSettings(input), (error: unknown) => error instanceof ServiceError && error.code === 'ADMIN_REQUIRED');
    await assert.rejects(customer.service.getRestaurantSettings(), (error: unknown) => error instanceof ServiceError && error.code === 'ADMIN_REQUIRED');
    assert.equal(customer.state.calls.length, 0);
    assert.equal((await customer.service.getBusiness()).deliveryFeePaise, 1234, 'customers read new terms');
  } finally { customer.cleanup(); }
  const demo = createMarketServices({ businessSlug: 'ammu-sammu', audience: 'admin', config: {} });
  try { await assert.rejects(demo.saveRestaurantSettings(input), (error: unknown) => error instanceof ServiceError && error.code === 'DEMO_MODE'); }
  finally { demo.dispose(); }
});
test('server conflicts, revoked access, field errors and incomplete confirmations never report success', async () => {
  const { service, state, cleanup } = await fixture();
  try {
    for (const [code, expected] of [['40001', 'SETTINGS_CHANGED'], ['42501', 'ADMIN_REQUIRED'], ['XX000', 'XX000']]) {
      state.error = { code, message: 'server refused' };
      await assert.rejects(service.saveRestaurantSettings(input), (error: unknown) => error instanceof ServiceError && error.code === expected);
    }
    state.error = { code: '22023', message: 'Enter an Indian mobile number.', details: 'whatsappPhone' };
    await assert.rejects(service.saveRestaurantSettings(input), (error: unknown) => error instanceof RestaurantSettingsValidationError && !!error.fields.whatsappPhone);
    state.error = null;
    for (const result of [null, {}, { ...businessRow, settings_version: 3 }, { ...businessRow, settings_version: 4, delivery_fee_paise: 2 }]) {
      state.result = result;
      await assert.rejects(service.saveRestaurantSettings(input), (error: unknown) => error instanceof ServiceError && error.code === 'INVALID_RESPONSE');
    }
  } finally { cleanup(); }
});
test('a save awaiting membership cannot act as a different owner or a replacement login session', async () => {
  for (const scenario of ['other-owner', 'new-session', 'matching-refresh', 'disposed'] as const) {
    const { service, state, cleanup } = await fixture();
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let reached!: () => void;
    const membership = new Promise<void>(resolve => { reached = resolve; });
    state.onMembership = async () => { reached(); await held; };
    try {
      const pending = service.saveRestaurantSettings(input).then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
      await membership;
      if (scenario === 'disposed') service.dispose();
      else {
        state.userId = scenario === 'other-owner' ? 'other' : 'owner';
        state.token = jwt(state.userId, scenario === 'new-session' ? 'new-session' : 'session');
        await service.auth.setSession(state.token, 'refresh');
      }
      release();
      const result = await pending;
      if (scenario === 'matching-refresh') { assert.equal(result.value?.version, 4); assert.equal(state.calls.length, 1); }
      else { assert.equal(result.error?.code, 'SESSION_CHANGED'); assert.equal(state.calls.length, 0); }
    } finally { release(); cleanup(); }
  }
});

test('the settings read maps order prefix and delivery-area status strictly, without the polygon', () => {
  const row = { contact_phone: null, whatsapp_phone: null, delivery_fee_paise: 0, min_order_paise: 0, settings_version: 1, order_prefix: 'KDI', service_area_source: 'survey', service_area_version: 'radius-2500m', service_area_verified_at: '2026-11-10T00:00:00Z' };
  assert.deepEqual(mapRestaurantSettingsView(row).deliveryArea, { kind: 'radius', radiusM: 2500 });
  assert.equal(mapRestaurantSettingsView(row).orderPrefix, 'KDI');
  assert.deepEqual(mapRestaurantSettingsView({ ...row, service_area_version: 'hand-drawn-v2' }).deliveryArea, { kind: 'verified' });
  assert.deepEqual(mapRestaurantSettingsView({ ...row, service_area_version: 'radius-100m' }).deliveryArea, { kind: 'verified' }, 'out-of-range radius is not shown as a distance');
  for (const patch of [{ service_area_verified_at: null }, { service_area_source: null }, { service_area_version: '  ' }, { service_area_source: undefined, service_area_version: undefined, service_area_verified_at: undefined }]) assert.deepEqual(mapRestaurantSettingsView({ ...row, ...patch }).deliveryArea, { kind: 'unverified' });
  for (const patch of [{ order_prefix: undefined }, { order_prefix: 'ams' }, { order_prefix: 'A' }, { service_area_version: 5 }, { service_area_verified_at: 1 }]) assert.throws(() => mapRestaurantSettingsView({ ...row, ...patch }), (error: unknown) => error instanceof ServiceError && error.code === 'INVALID_RESPONSE');
});
