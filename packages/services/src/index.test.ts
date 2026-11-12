import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMarketServices, mapMenu, mapOrder, sessionStorageKey, ServiceError } from './index.ts';

const slug = 'ammu-sammu' as const;
test('sessions are separated by business, audience, and backend', () => {
  const key = sessionStorageKey('https://one.example/', slug, 'customer');
  assert.equal(key, sessionStorageKey('https://one.example', slug, 'customer'));
  assert.notEqual(key, sessionStorageKey('https://one.example', slug, 'admin'));
  assert.notEqual(key, sessionStorageKey('https://one.example', 'konkan-fine-dine', 'customer'));
  assert.notEqual(key, sessionStorageKey('https://two.example', slug, 'customer'));
});
test('demo browsing is labelled and checkout fails closed', async () => {
  const service = createMarketServices({ businessSlug: slug, audience: 'customer', config: {} });
  assert.equal(service.mode, 'demo');
  assert.equal((await service.getBusiness()).orderingEnabled, false);
  assert.equal((await service.getMenu())[0].isDemo, true);
  await assert.rejects(service.placeOrder({ lines: [], delivery: { name: '', phone: '', addressLine: '' }, location: { latitude: 0, longitude: 0, accuracy: 0, capturedAtISO: '' }, idempotencyKey: 'key' }), (e: unknown) => e instanceof ServiceError && e.code === 'DEMO_MODE');
  assert.throws(() => createMarketServices({ businessSlug: slug, audience: 'customer', config: { url: 'https://one.example' } }), /both EXPO_PUBLIC/);
});
test('maps database menu and complete order into domain values', () => {
  assert.deepEqual(mapMenu({ id: 'm', name: 'Dish', description: null, category: 'Main', price_paise: 1200, available: true, is_demo: false, image_url: null }, slug), { id: 'm', businessId: slug, name: 'Dish', description: '', category: 'Main', pricePaise: 1200, isAvailable: true, isDemo: false });
  const order = mapOrder({ id: 'o', status: 'placed', version: 1, subtotal_paise: 1200, delivery_fee_paise: 100, total_paise: 1300, customer_name: 'Name', customer_phone: 'Phone', delivery_address_line: 'Address', created_at: '2026-01-01', order_items: [{ menu_item_id: 'm', name: 'Dish', quantity: 1, unit_price_paise: 1200, line_total_paise: 1200 }], order_status_history: [{ status: 'accepted', created_at: '2026-01-02' }, { status: 'placed', created_at: '2026-01-01' }] }, slug);
  assert.equal(order.lines[0].unitPricePaise, 1200);
  assert.equal(order.delivery.addressLine, 'Address');
  assert.deepEqual(order.history?.map(entry => entry.status), ['placed', 'accepted']);
});
test('configured backend errors do not fall back to sample data', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ message: 'database unavailable', code: 'BAD' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
  try {
    const service = createMarketServices({ businessSlug: slug, audience: 'customer', config: { url: 'https://example.test', anonKey: 'sb_publishable_test' } });
    await assert.rejects(service.getMenu(), /database unavailable/);
  } finally { globalThis.fetch = original; }
});

test('realtime invalidates on events and reconnect and cleans up', async () => {
  const { subscribeToOrderChanges } = await import('./index.ts');
  let event: (() => void) | undefined;
  let status: ((value: string) => void) | undefined;
  let filter = '';
  let removed = false;
  let refreshes = 0;
  let errors = 0;
  const channel = {
    on(_kind: string, spec: { filter: string }, callback: () => void) { filter = spec.filter; event = callback; return this; },
    subscribe(callback: (value: string) => void) { status = callback; return this; },
  };
  const client = { channel: () => channel, removeChannel: async (value: unknown) => { assert.equal(value, channel); removed = true; } };
  const cleanup = subscribeToOrderChanges(client as never, 'tenant-id', slug, 'customer', () => { refreshes++; }, () => { errors++; });
  assert.equal(filter, 'business_id=eq.tenant-id');
  status?.('SUBSCRIBED'); event?.(); status?.('TIMED_OUT'); status?.('SUBSCRIBED');
  assert.equal(refreshes, 3); assert.equal(errors, 1);
  cleanup(); event?.(); status?.('SUBSCRIBED');
  assert.equal(removed, true); assert.equal(refreshes, 3);
});

test('accepts only publishable or legacy anon client keys', () => {
  const jwt = (role: string) => `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({ role })).toString('base64url')}.signature`;
  for (const key of ['sb_secret_do-not-log', jwt('service_role'), jwt('authenticated'), 'garbage', 'a.!.c']) {
    assert.throws(() => createMarketServices({ businessSlug: slug, audience: 'customer', config: { url: 'https://example.test', anonKey: key } }), (error: unknown) => error instanceof ServiceError && error.code === 'INVALID_CONFIG' && !error.message.includes(key));
  }
  for (const key of ['sb_publishable_test', jwt('anon')]) {
    const service = createMarketServices({ businessSlug: slug, audience: 'customer', config: { url: 'https://example.test', anonKey: key } });
    assert.equal(service.mode, 'backend'); service.dispose();
  }
});

test('blocked storage falls back to per-instance memory without an unhandled initialization error', async () => {
  const rejected = { getItem: async () => { throw new Error('blocked'); }, setItem: async () => { throw new Error('blocked'); }, removeItem: async () => { throw new Error('blocked'); } };
  const service = createMarketServices({ businessSlug: slug, audience: 'customer', config: { url: 'https://example.test', anonKey: 'sb_publishable_test' }, storage: rejected });
  assert.equal(await service.auth.session(), null);
  assert.equal(service.persistenceAvailable(), false);
  service.dispose();
});

test('SDK channel stops on sign out and dispose, including an in-flight subscription', async () => {
  const { SupabaseClient } = await import('@supabase/supabase-js');
  const originalFetch = globalThis.fetch;
  const originalChannel = SupabaseClient.prototype.channel;
  const originalRemove = SupabaseClient.prototype.removeChannel;
  let onEvent: (() => void) | undefined;
  let onStatus: ((status: string) => void) | undefined;
  let removed = 0;
  let refreshes = 0;
  const channel = { on(_type: string, _filter: unknown, callback: () => void) { onEvent = callback; return this; }, subscribe(callback: (status: string) => void) { onStatus = callback; return this; } };
  SupabaseClient.prototype.channel = (() => channel) as never;
  SupabaseClient.prototype.removeChannel = (async () => { removed++; return 'ok'; }) as never;
  const token = `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: 'user1', role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.signature`;
  let unblockBusiness: (() => void) | undefined;
  let holdBusiness = false;
  let userId = 'user1';
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes('/auth/v1/token')) return Response.json({ access_token: token, refresh_token: 'refresh', expires_in: 3600, token_type: 'bearer', user: { id: userId, aud: 'authenticated' } });
    if (url.includes('/auth/v1/logout')) { assert.equal(new URL(url).searchParams.get('scope'), 'local'); return new Response(null, { status: 204 }); }
    if (url.includes('/rest/v1/businesses')) {
      if (holdBusiness) await new Promise<void>(resolve => { unblockBusiness = resolve; });
      return Response.json({ id: 'tenant-id', slug, name: 'Business', delivery_fee_paise: 0, min_order_paise: 0, is_demo: false, ordering_enabled: true });
    }
    throw new Error(`Unexpected request ${url}`);
  };
  const memory = new Map<string, string>();
  const storage = { getItem: (k: string) => memory.get(k) ?? null, setItem: (k: string, v: string) => { memory.set(k, v); }, removeItem: (k: string) => { memory.delete(k); } };
  try {
    const service = createMarketServices({ businessSlug: slug, audience: 'customer', config: { url: 'https://example.test', anonKey: 'sb_publishable_test' }, storage });
    await service.auth.signIn('user@example.test', 'password');
    await service.subscribeOrders(() => { refreshes++; });
    onStatus?.('SUBSCRIBED'); onEvent?.();
    assert.equal(refreshes, 2);
    await service.auth.signOut();
    assert.equal(removed, 1);
    onEvent?.(); onStatus?.('SUBSCRIBED'); assert.equal(refreshes, 2);
    await service.auth.signIn('user@example.test', 'password');
    await service.subscribeOrders(() => { refreshes++; });
    userId = 'user2';
    await service.auth.signIn('other@example.test', 'password');
    assert.equal(removed, 2);
    onEvent?.(); assert.equal(refreshes, 2);
    holdBusiness = true;
    const pending = service.subscribeOrders(() => { refreshes++; });
    while (!unblockBusiness) await new Promise(resolve => setTimeout(resolve, 0));
    service.dispose(); unblockBusiness();
    await assert.rejects(pending, (error: unknown) => error instanceof ServiceError && error.code === 'SESSION_CHANGED');
    assert.equal(removed, 2);
  } finally { globalThis.fetch = originalFetch; SupabaseClient.prototype.channel = originalChannel; SupabaseClient.prototype.removeChannel = originalRemove; }
});

test('admin catalogue mutations use checked membership and tenant-scoped requests', async () => {
  const originalFetch = globalThis.fetch;
  const calls: { url: URL; method: string; body: Record<string, unknown> }[] = [];
  const memory = new Map<string, string>();
  const storage = { getItem: (k: string) => memory.get(k) ?? null, setItem: (k: string, v: string) => { memory.set(k, v); }, removeItem: (k: string) => { memory.delete(k); } };
  const token = `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: 'user1', role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.signature`;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/auth/v1/token')) return Response.json({ access_token: token, refresh_token: 'refresh', expires_in: 3600, token_type: 'bearer', user: { id: 'user1', aud: 'authenticated' } });
    if (url.pathname.endsWith('/auth/v1/user')) return Response.json({ id: 'user1', aud: 'authenticated' });
    if (url.pathname.endsWith('/businesses')) return Response.json({ id: 'tenant-id', slug, name: 'Business', delivery_fee_paise: 0, min_order_paise: 0, is_demo: false, ordering_enabled: true });
    if (url.pathname.endsWith('/business_memberships')) {
      assert.equal(url.searchParams.get('business_id'), 'eq.tenant-id');
      assert.equal(url.searchParams.get('user_id'), 'eq.user1');
      return Response.json({ role: 'admin' });
    }
    if (url.pathname.endsWith('/menu_items')) {
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      calls.push({ url, method, body });
      return Response.json(method === 'DELETE' ? { id: 'item1' } : { id: 'item1', name: 'Dish', description: '', category: 'Main', price_paise: 100, available: true, is_demo: true, image_url: null });
    }
    throw new Error(`Unexpected request ${url}`);
  };
  try {
    const service = createMarketServices({ businessSlug: slug, audience: 'admin', config: { url: 'https://example.test', anonKey: 'sb_publishable_test' }, storage });
    await service.auth.signIn('admin@example.test', 'password');
    const item = { name: 'Dish', description: '', category: 'Main', pricePaise: 100, isAvailable: true, isDemo: true };
    await service.saveMenuItem(item); await service.saveMenuItem({ ...item, id: 'item1' }); await service.deleteMenuItem('item1');
    assert.equal(calls[0].method, 'POST'); assert.equal(calls[0].body.business_id, 'tenant-id'); assert.equal(calls[0].body.is_demo, true);
    for (const call of calls.slice(1)) { assert.equal(call.url.searchParams.get('id'), 'eq.item1'); assert.equal(call.url.searchParams.get('business_id'), 'eq.tenant-id'); }
    assert.equal(calls[1].method, 'PATCH'); assert.equal(calls[1].body.business_id, undefined); assert.equal(calls[2].method, 'DELETE');
    await assert.rejects(service.saveMenuItem({ ...item, pricePaise: 1.5 }), /positive whole price/);
    await assert.rejects(service.saveMenuItem({ ...item, isDemo: undefined as never }), /sample status/);
    assert.equal(calls.length, 3); service.dispose();
  } finally { globalThis.fetch = originalFetch; }
});

test('password reset uses PKCE and persists the verifier', async () => {
  const originalFetch = globalThis.fetch;
  const memory = new Map<string, string>();
  const storage = { getItem: (k: string) => memory.get(k) ?? null, setItem: (k: string, v: string) => { memory.set(k, v); }, removeItem: (k: string) => { memory.delete(k); } };
  let body: Record<string, unknown> = {};
  globalThis.fetch = async (_input, init) => { body = JSON.parse(String(init?.body)); return Response.json({}); };
  try {
    const service = createMarketServices({ businessSlug: slug, audience: 'customer', config: { url: 'https://example.test', anonKey: 'sb_publishable_test' }, storage });
    await service.auth.resetPassword('user@example.test', 'market://reset');
    assert.equal(typeof body.code_challenge, 'string');
    assert.equal(body.code_challenge_method, 's256');
    assert.ok([...memory.keys()].some(key => key.endsWith('-code-verifier')));
    service.dispose();
  } finally { globalThis.fetch = originalFetch; }
});
