import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMarketServices, mapMenu, mapOrder, sessionStorageKey, ServiceError } from './index.ts';

const slug = 'ammu-sammu' as const;
test('sessions are separated by business, audience, and backend', () => {
  const key = sessionStorageKey('https://one.example/', slug, 'customer');
  assert.equal(key, sessionStorageKey('https://one.example', slug, 'customer'));
  assert.notEqual(key, sessionStorageKey('https://one.example', slug, 'admin'));
  assert.notEqual(key, sessionStorageKey('https://one.example', 'kokani-dine-inn', 'customer'));
  assert.notEqual(key, sessionStorageKey('https://two.example', slug, 'customer'));
});
test('demo browsing is labelled and checkout fails closed', async () => {
  const service = createMarketServices({ businessSlug: slug, audience: 'customer', config: {} });
  assert.equal(service.mode, 'demo');
  assert.equal((await service.getBusiness()).orderingEnabled, false);
  assert.equal((await service.getBusiness()).acceptingOrders, false);
  assert.equal((await service.getMenu())[0].isDemo, true);
  await assert.rejects(service.placeOrder({ pricing: { lines: [], delivery_fee_paise: 0, min_order_paise: 0, subtotal_paise: 0, total_paise: 0 }, lines: [], delivery: { name: '', phone: '', addressLine: '' }, location: { latitude: 0, longitude: 0, accuracy: 0, capturedAtISO: '' }, idempotencyKey: 'key' }), (e: unknown) => e instanceof ServiceError && e.code === 'DEMO_MODE');
  assert.throws(() => createMarketServices({ businessSlug: slug, audience: 'customer', config: { url: 'https://one.example' } }), /both EXPO_PUBLIC/);
});
test('maps database menu and complete order into domain values', () => {
  assert.deepEqual(mapMenu({ diet: null, id: 'm', name: 'Dish', description: null, category: 'Main', price_paise: 1200, available: true, is_demo: false, image_url: null }, slug), { id: 'm', businessId: slug, name: 'Dish', description: '', category: 'Main', diet: null, pricePaise: 1200, isAvailable: true, isDemo: false });
  const order = mapOrder({ id: 'o', status: 'placed', version: 1, subtotal_paise: 1200, delivery_fee_paise: 100, total_paise: 1300, customer_name: 'Name', customer_phone: 'Phone', delivery_address_line: 'Address', created_at: '2026-01-01', order_items: [{ diet: 'egg', menu_item_id: 'm', name: 'Dish', quantity: 1, unit_price_paise: 1200, line_total_paise: 1200 }], order_status_history: [{ status: 'accepted', created_at: '2026-01-02' }, { status: 'placed', created_at: '2026-01-01' }] }, slug);
  assert.equal(order.lines[0].unitPricePaise, 1200);
  assert.equal(order.lines[0].diet, 'egg');
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
      return Response.json(method === 'DELETE' ? { id: 'item1' } : { diet: 'egg', id: 'item1', name: 'Dish', description: '', category: 'Main', price_paise: 100, available: true, is_demo: true, image_url: null });
    }
    throw new Error(`Unexpected request ${url}`);
  };
  try {
    const service = createMarketServices({ businessSlug: slug, audience: 'admin', config: { url: 'https://example.test', anonKey: 'sb_publishable_test' }, storage });
    await service.auth.signIn('admin@example.test', 'password');
    const item = { diet: 'egg' as const, name: 'Dish', description: '', category: 'Main', pricePaise: 100, isAvailable: true, isDemo: true };
    await service.saveMenuItem(item); await service.saveMenuItem({ ...item, id: 'item1' }); await service.deleteMenuItem('item1');
    assert.equal(calls[0].body.diet, 'egg');
    assert.equal(calls[0].method, 'POST'); assert.equal(calls[0].body.business_id, 'tenant-id'); assert.equal(calls[0].body.is_demo, true);
    for (const call of calls.slice(1)) { assert.equal(call.url.searchParams.get('id'), 'eq.item1'); assert.equal(call.url.searchParams.get('business_id'), 'eq.tenant-id'); }
    assert.equal(calls[1].method, 'PATCH'); assert.equal(calls[1].body.business_id, undefined); assert.equal(calls[2].method, 'DELETE');
    await assert.rejects(service.saveMenuItem({ ...item, pricePaise: 1.5 }), /positive whole price/);
    await assert.rejects(service.saveMenuItem({ ...item, isDemo: undefined as never }), /sample status/);
    for (const diet of [null, undefined, 'fish']) {
      await assert.rejects(service.saveMenuItem({ ...item, diet: diet as never }), /Choose Vegetarian/);
    }
    await service.saveMenuItem({ ...item, id: 'item1', diet: null });
    assert.equal(calls[3].body.diet, null, 'an existing unknown dish can remain unknown');
    assert.equal(calls.length, 4); service.dispose();
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

test('browser callback waits for explicit code exchange', async () => {
  const originalFetch = globalThis.fetch;
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const channelDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'BroadcastChannel');
  const memory = new Map<string, string>();
  const key = sessionStorageKey('https://example.test', slug, 'customer');
  memory.set(`${key}-code-verifier`, JSON.stringify('stored-verifier'));
  const storage = { getItem: (k: string) => memory.get(k) ?? null, setItem: (k: string, v: string) => { memory.set(k, v); }, removeItem: (k: string) => { memory.delete(k); } };
  const requests: Record<string, unknown>[] = [];
  const token = `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: 'user1', role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.signature`;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { href: 'https://app.example.test/?code=callback-code' }, addEventListener() {}, removeEventListener() {} } });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} } });
  Object.defineProperty(globalThis, 'BroadcastChannel', { configurable: true, value: undefined });
  globalThis.fetch = async (_input, init) => {
    requests.push(JSON.parse(String(init?.body)));
    return Response.json({ access_token: token, refresh_token: 'refresh', expires_in: 3600, token_type: 'bearer', user: { id: 'user1', aud: 'authenticated' } });
  };
  try {
    const service = createMarketServices({ businessSlug: slug, audience: 'customer', config: { url: 'https://example.test', anonKey: 'sb_publishable_test' }, storage });
    assert.equal(await service.auth.session(), null);
    assert.equal(requests.length, 0);
    assert.ok(memory.has(`${key}-code-verifier`));
    await service.auth.exchangeCodeForSession('callback-code');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].auth_code, 'callback-code');
    assert.equal(requests[0].code_verifier, 'stored-verifier');
    service.dispose();
  } finally {
    globalThis.fetch = originalFetch;
    for (const [name, descriptor] of [['window', windowDescriptor], ['document', documentDescriptor], ['BroadcastChannel', channelDescriptor]] as const) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
    }
  }
});

test('signout removes a stale stored session after writes fail', async () => {
  const originalFetch = globalThis.fetch;
  const memory = new Map<string, string>();
  let failWrites = false;
  const storage = { getItem: (k: string) => memory.get(k) ?? null, setItem: (k: string, v: string) => { if (failWrites) throw new Error('quota'); memory.set(k, v); }, removeItem: (k: string) => { memory.delete(k); } };
  const token = `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: 'user1', role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.signature`;
  globalThis.fetch = async (input) => String(input).includes('/logout') ? new Response(null, { status: 204 }) : Response.json({ access_token: token, refresh_token: 'refresh', expires_in: 3600, token_type: 'bearer', user: { id: 'user1', aud: 'authenticated' } });
  try {
    const options = { businessSlug: slug, audience: 'customer' as const, config: { url: 'https://example.test', anonKey: 'sb_publishable_test' }, storage };
    const service = createMarketServices(options);
    await service.auth.signIn('user@example.test', 'password');
    assert.ok(memory.has(sessionStorageKey(options.config.url, slug, 'customer')));
    failWrites = true;
    await service.auth.signIn('user@example.test', 'password');
    assert.equal(service.persistenceAvailable(), false);
    await service.auth.signOut(); service.dispose();
    const restored = createMarketServices(options);
    assert.equal(await restored.auth.session(), null); restored.dispose();
  } finally { globalThis.fetch = originalFetch; }
});

test('device token RPCs accept refreshed credentials only for the initiating user and session', async () => {
  const original = globalThis.fetch;
  const jwt = (sub: string, session_id: string, version: number) => `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub, session_id, version, role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.sig`;
  const initial = jwt('u1', 'session1', 1), refreshed = jwt('u1', 'session1', 2), otherSession = jwt('u1', 'session2', 1), otherUser = jwt('u2', 'session1', 1);
  let activeToken = initial, activeUser = 'u1';
  const requests: { url: string; auth: string | null; body: unknown }[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes('/auth/v1/token')) return Response.json({ access_token: activeToken, refresh_token: 'refresh', expires_in: 3600, token_type: 'bearer', user: { id: activeUser, aud: 'authenticated' } });
    requests.push({ url, auth: new Headers(init?.headers).get('Authorization'), body: JSON.parse(String(init?.body)) });
    return Response.json(null);
  };
  const service = createMarketServices({ businessSlug: slug, audience: 'admin', config: { url: 'https://example.test', anonKey: 'sb_publishable_test' } });
  try {
    await service.auth.signIn('person@example.test', 'password');
    await service.registerDeviceToken('device', initial);
    activeToken = refreshed; await service.auth.signIn('person@example.test', 'password');
    await service.unregisterDeviceToken('device', initial);
    activeToken = otherSession; await service.auth.signIn('person@example.test', 'password');
    await assert.rejects(service.unregisterDeviceToken('device', initial), (e: unknown) => e instanceof ServiceError && e.code === 'SESSION_CHANGED');
    activeToken = otherUser; activeUser = 'u2'; await service.auth.signIn('other@example.test', 'password');
    await assert.rejects(service.registerDeviceToken('device', initial), (e: unknown) => e instanceof ServiceError && e.code === 'SESSION_CHANGED');
    await assert.rejects(service.registerDeviceToken('device', 'stale'), (e: unknown) => e instanceof ServiceError && e.code === 'SESSION_CHANGED');
    assert.equal(requests.length, 2);
    assert.match(requests[0].url, /\/register_device_token$/);
    assert.match(requests[1].url, /\/unregister_device_token$/);
    assert.equal(requests[0].auth, `Bearer ${initial}`);
    assert.equal(requests[1].auth, `Bearer ${refreshed}`);
    assert.deepEqual(requests[0].body, { p_business_slug: slug, p_audience: 'admin', p_token: 'device' });
  } finally { service.dispose(); globalThis.fetch = original; }
});

test('business state realtime follows open/closed and dish changes, reconnects and cleans up', async () => {
  const { subscribeToBusinessState } = await import('./index.ts');
  const listeners: { table: string; event: string; filter?: string; callback: () => void }[] = [];
  let status: ((value: string) => void) | undefined;
  let removed = false, refreshes = 0, errors = 0;
  const channel = {
    on(_kind: string, spec: { table: string; event: string; filter?: string }, callback: () => void) { listeners.push({ ...spec, callback }); return this; },
    subscribe(callback: (value: string) => void) { status = callback; return this; },
  };
  const client = { channel: () => channel, removeChannel: async (value: unknown) => { assert.equal(value, channel); removed = true; } };
  const cleanup = subscribeToBusinessState(client as never, 'tenant-id', slug, 'customer', () => { refreshes++; }, () => { errors++; });
  assert.deepEqual(listeners.map(({ table, event, filter }) => ({ table, event, filter })), [
    { table: 'businesses', event: 'UPDATE', filter: 'id=eq.tenant-id' },
    { table: 'menu_items', event: 'INSERT', filter: 'business_id=eq.tenant-id' },
    { table: 'menu_items', event: 'UPDATE', filter: 'business_id=eq.tenant-id' },
    { table: 'menu_items', event: 'DELETE', filter: undefined },
  ]);
  status?.('SUBSCRIBED'); for (const listener of listeners) listener.callback(); status?.('CHANNEL_ERROR'); status?.('SUBSCRIBED');
  assert.equal(refreshes, 6); assert.equal(errors, 1);
  cleanup(); listeners[0].callback(); status?.('SUBSCRIBED');
  assert.equal(removed, true); assert.equal(refreshes, 6);
});

test('open/closed is read, changed only by owners, and a closed refusal has its own error', async () => {
  const originalFetch = globalThis.fetch;
  const memory = new Map<string, string>();
  const storage = { getItem: (k: string) => memory.get(k) ?? null, setItem: (k: string, v: string) => { memory.set(k, v); }, removeItem: (k: string) => { memory.delete(k); } };
  const token = `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: 'user1', role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.signature`;
  let business: Record<string, unknown> = { id: 'tenant-id', slug, name: 'Business', delivery_fee_paise: 0, min_order_paise: 0, is_demo: false, ordering_enabled: true, accepting_orders: true };
  let admin = true;
  const rpcs: { name: string; body: Record<string, unknown> }[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/auth/v1/token')) return Response.json({ access_token: token, refresh_token: 'refresh', expires_in: 3600, token_type: 'bearer', user: { id: 'user1', aud: 'authenticated' } });
    if (url.pathname.endsWith('/auth/v1/user')) return Response.json({ id: 'user1', aud: 'authenticated' });
    if (url.pathname.endsWith('/businesses')) { assert.match(url.searchParams.get('select') ?? '', /accepting_orders/); return Response.json(business); }
    if (url.pathname.endsWith('/business_memberships')) return Response.json(admin ? { role: 'admin' } : null);
    if (url.pathname.includes('/rpc/')) {
      const name = url.pathname.split('/').pop()!;
      rpcs.push({ name, body: JSON.parse(String(init?.body)) });
      if (name === 'set_accepting_orders') return Response.json({ business_id: 'tenant-id', accepting_orders: false });
      if (name === 'place_order') return Response.json({ code: 'PT409', message: 'restaurant is not accepting orders', details: null, hint: null }, { status: 409 });
    }
    throw new Error(`Unexpected request ${url}`);
  };
  try {
    const owner = createMarketServices({ businessSlug: slug, audience: 'admin', config: { url: 'https://example.test', anonKey: 'sb_publishable_test' }, storage });
    await owner.auth.signIn('owner@example.test', 'password');
    assert.equal((await owner.getBusiness()).acceptingOrders, true);
    business = { ...business, accepting_orders: undefined };
    assert.equal((await owner.getBusiness()).acceptingOrders, false, 'missing value fails closed');
    assert.equal(await owner.setAcceptingOrders(false), false);
    assert.deepEqual(rpcs[0], { name: 'set_accepting_orders', body: { p_business_slug: slug, p_accepting: false } });
    await assert.rejects(owner.setAcceptingOrders('no' as never), (e: unknown) => e instanceof ServiceError && e.code === 'INVALID_VALUE');
    admin = false;
    await assert.rejects(owner.setAcceptingOrders(true), (e: unknown) => e instanceof ServiceError && e.code === 'ADMIN_REQUIRED');
    assert.equal(rpcs.length, 1); owner.dispose();

    const customer = createMarketServices({ businessSlug: slug, audience: 'customer', config: { url: 'https://example.test', anonKey: 'sb_publishable_test' }, storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } });
    await assert.rejects(customer.setAcceptingOrders(true), (e: unknown) => e instanceof ServiceError && e.code === 'ADMIN_REQUIRED');
    await customer.auth.signIn('customer@example.test', 'password');
    const item = { id: 'm', businessId: slug, name: 'Dish', description: '', category: 'Main', pricePaise: 100, isAvailable: true, isDemo: false };
    await assert.rejects(customer.placeOrder({ pricing: { lines: [], delivery_fee_paise: 0, min_order_paise: 0, subtotal_paise: 0, total_paise: 0 }, lines: [{ item, quantity: 1 }], delivery: { name: 'N', phone: '1', addressLine: 'A' }, location: { latitude: 0.5, longitude: 0.5, accuracy: 10, capturedAtISO: new Date().toISOString() }, idempotencyKey: 'key' }), (e: unknown) => e instanceof ServiceError && e.code === 'NOT_ACCEPTING_ORDERS');
    customer.dispose();
  } finally { globalThis.fetch = originalFetch; }
});

test('demo diet stays unknown and explicit menu marks map for both restaurants', async () => {
  for (const businessSlug of ['ammu-sammu', 'kokani-dine-inn'] as const) {
    const service = createMarketServices({ businessSlug, audience: 'customer', config: {} });
    assert.equal((await service.getMenu())[0].diet, null);
    for (const diet of ['veg', 'egg', 'non_veg', null] as const) {
      assert.equal(mapMenu({ id: 'm', name: 'Dish', description: null, category: 'Main', price_paise: 100, available: true, is_demo: false, image_url: null, diet }, businessSlug).diet, diet);
    }
    service.dispose();
  }
});

test('revised pricing validates every line and amount before releasing the uncertain attempt', async () => {
  const { validateRevisedPricing } = await import('./index.ts');
  const lines = [{ item: { id: 'dish', businessId: slug, name: 'Dish', description: '', category: 'Main', pricePaise: 100, isAvailable: true, isDemo: false }, quantity: 2 }];
  const valid = { lines: [{ menu_item_id: 'dish', quantity: 2, unit_price_paise: 150, line_total_paise: 300 }], delivery_fee_paise: 40, min_order_paise: 500, subtotal_paise: 300, total_paise: 340 };
  assert.deepEqual(validateRevisedPricing(valid, lines), valid, 'below minimum is a valid revised quote');
  for (const value of [null, {}, { ...valid, total_paise: 1 }, { ...valid, delivery_fee_paise: -1 }, { ...valid, min_order_paise: '500' }, { ...valid, subtotal_paise: 1 }, { ...valid, lines: [] }, { ...valid, lines: [{ ...valid.lines[0], menu_item_id: 'foreign' }] }, { ...valid, lines: [{ ...valid.lines[0], quantity: 3 }] }, { ...valid, lines: [{ ...valid.lines[0], unit_price_paise: 0 }] }, { ...valid, lines: [{ ...valid.lines[0], line_total_paise: 1 }] }]) {
    assert.throws(() => validateRevisedPricing(value, lines), (e: unknown) => e instanceof ServiceError && e.code === 'INVALID_RESPONSE');
  }
});

test('checkout passes frozen terms and treats only validated no-order responses as revised pricing', async () => {
  const { PricingChangedError } = await import('./index.ts');
  const originalFetch = globalThis.fetch;
  const item = { id: '20000000-0000-4000-8000-000000000001', businessId: slug, name: 'Dish', description: '', category: 'Main', pricePaise: 100, isAvailable: true, isDemo: false };
  const pricing = { lines: [{ menu_item_id: item.id, quantity: 1, unit_price_paise: 100, line_total_paise: 100 }], delivery_fee_paise: 20, min_order_paise: 0, subtotal_paise: 100, total_paise: 120 };
  const request = { lines: [{ item, quantity: 1 }], pricing, delivery: { name: 'Name', phone: '123', addressLine: 'Address' }, location: { latitude: 0.5, longitude: 0.5, accuracy: 10, capturedAtISO: new Date().toISOString() }, idempotencyKey: 'key' };
  const revised = { ...pricing, delivery_fee_paise: 40, total_paise: 140 };
  let response: unknown = { outcome: 'pricing_changed', pricing: revised };
  let orderReply: Record<string, unknown> | null = null;
  const calls: unknown[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/rpc/place_order')) { calls.push(JSON.parse(String(init?.body))); return Response.json(response); }
    if (url.pathname.endsWith('/businesses')) return Response.json({ id: 'tenant', slug, name: 'Test', delivery_fee_paise: 999, min_order_paise: 999, is_demo: false, ordering_enabled: true, accepting_orders: true });
    if (url.pathname.endsWith('/orders')) return orderReply ? Response.json(orderReply) : Response.json({ message: 'saved details unavailable', code: '22023' }, { status: 400 });
    throw new Error('Unexpected request ' + url);
  };
  const service = createMarketServices({ businessSlug: slug, audience: 'customer', config: { url: 'https://pricing.example.test', anonKey: 'sb_publishable_test' }, storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } });
  try {
    await assert.rejects(service.placeOrder(request), (e: unknown) => e instanceof PricingChangedError && e.pricing.total_paise === 140);
    assert.deepEqual((calls[0] as { p_accepted_pricing: unknown }).p_accepted_pricing, pricing, 'never fetch current business terms to replace accepted prices');
    for (const invalid of [{ outcome: 'pricing_changed', pricing: { ...revised, total_paise: 1 } }, { outcome: 'pricing_changed', pricing: revised, id: 'order' }, { id: '40000000-0000-4000-8000-000000000001' }, { outcome: 'placed', id: 'invalid' }, null]) {
      response = invalid;
      await assert.rejects(service.placeOrder(request), (e: unknown) => e instanceof ServiceError && e.code === 'INVALID_RESPONSE');
    }
    response = { outcome: 'placed', id: '40000000-0000-4000-8000-000000000001' };
    await assert.rejects(service.placeOrder(request), /Order was saved, but its details could not be loaded/);
    orderReply = { id: '40000000-0000-4000-8000-000000000001', status: 'placed', version: 1, subtotal_paise: 100, delivery_fee_paise: 20, total_paise: 121, customer_name: 'Name', customer_phone: '123', delivery_address_line: 'Address', created_at: '2026-11-14', order_items: [{ menu_item_id: item.id, name: 'Dish', quantity: 1, unit_price_paise: 100, line_total_paise: 100 }], order_status_history: [] };
    await assert.rejects(service.placeOrder(request), /does not match the accepted pricing/);
    orderReply.total_paise = 120;
    assert.equal((await service.placeOrder(request)).totalPaise, 120);
  } finally { service.dispose(); globalThis.fetch = originalFetch; }
});
