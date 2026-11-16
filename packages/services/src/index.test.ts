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

test('photo service binds business and expected pointer, sends bytes, and surfaces server validation', async () => {
  const original = globalThis.fetch;
  const token = `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({sub:'owner',role:'authenticated',exp:Math.floor(Date.now()/1000)+3600})).toString('base64url')}.signature`;
  const row = { diet:'veg' as const,id:'20000000-0000-4000-8000-000000000001',name:'Dish',description:'',category_id:'category',menu_categories:{name:'Meals',sort_order:0},price_paise:100,available:true,is_demo:false,is_featured:false,sort_order:0,image_url:'business/dish/version/card.webp' };
  const photoBase = 'https://example.test/storage/v1/object/public/menu-images/';
  const item = mapMenu(row,slug,photoBase);
  assert.equal(item.imageUrl,photoBase+row.image_url);
  let action = ''; let refuse = false;
  globalThis.fetch = async (input,init) => {
    if (String(input).includes('/auth/v1/token')) return Response.json({access_token:token,refresh_token:'refresh',expires_in:3600,token_type:'bearer',user:{id:'owner',aud:'authenticated'}});
    assert.equal(String(input),'https://example.test/functions/v1/menu-photos');
    const headers = new Headers(init?.headers); action = headers.get('x-photo-action')!;
    assert.equal(headers.get('x-business-slug'),slug);
    assert.equal(headers.get('authorization'),`Bearer ${token}`);
    if (action !== 'cleanup') { assert.equal(headers.get('x-menu-item'),item.id); assert.equal(headers.get('x-photo-expected'),row.image_url); }
    if (action === 'upload') assert.deepEqual([...new Uint8Array(init!.body as ArrayBuffer)],[1,2,3]);
    return Response.json(refuse ? {message:'This photo is damaged. Choose another JPEG, PNG or WebP.'} : {saved:true,cleanupComplete:false},{status:refuse ? 400 : 200});
  };
  const service = createMarketServices({businessSlug:slug,audience:'admin',config:{url:'https://example.test',anonKey:'sb_publishable_test'}});
  try {
    await service.auth.signIn('owner@example.test','password');
    assert.equal((await service.uploadMenuPhoto(item,new Uint8Array([1,2,3]).buffer)).cleanupComplete,false);
    await service.removeMenuPhoto(item); assert.equal(action,'remove');
    await service.retryMenuPhotoCleanup(); assert.equal(action,'cleanup');
    await assert.rejects(service.uploadMenuPhoto({...item,businessId:'kokani-dine-inn'},new ArrayBuffer(1)),/Reload this restaurant/);
    await assert.rejects(service.uploadMenuPhoto({...item,imageUrl:'https://untrusted.test/photo'},new ArrayBuffer(1)),/Reload this restaurant/);
    await assert.rejects(service.uploadMenuPhoto(item,new ArrayBuffer(5*1024*1024+1)),/up to 5 MB/);
    refuse = true;
    await assert.rejects(service.uploadMenuPhoto(item,new Uint8Array([1,2,3]).buffer),/photo is damaged/);
  } finally { service.dispose(); globalThis.fetch = original; }
});
test('photo service refuses customer and demo writes before making upload requests', async () => {
  const row = {diet:null,id:'dish',name:'Dish',description:'',category_id:'category',menu_categories:{name:'Meals',sort_order:0},price_paise:100,available:true,is_demo:false,is_featured:false,sort_order:0,image_url:null};
  const demo = createMarketServices({businessSlug:slug,audience:'admin',config:{}});
  const customer = createMarketServices({businessSlug:slug,audience:'customer',config:{url:'https://example.test',anonKey:'sb_publishable_test'}});
  try {
    await assert.rejects(demo.uploadMenuPhoto(mapMenu(row,slug),new ArrayBuffer(1)),(e:unknown) => e instanceof ServiceError && e.code==='DEMO_MODE');
    await assert.rejects(customer.uploadMenuPhoto(mapMenu(row,slug),new ArrayBuffer(1)),/admin account/);
    await assert.rejects(customer.retryMenuPhotoCleanup(),/admin account/);
  } finally { demo.dispose(); customer.dispose(); }
});
test('maps database menu and complete order into domain values', () => {
  assert.deepEqual(mapMenu({ diet: null, id: 'm', name: 'Dish', description: null, category_id: 'category-main', menu_categories: { name: 'Main', sort_order: 0 }, price_paise: 1200, available: true, is_demo: false, is_featured: false, sort_order: 0, image_url: null }, slug), { id: 'm', businessId: slug, name: 'Dish', description: '', category: 'Main', categoryId: 'category-main', categorySortOrder: 0, diet: null, pricePaise: 1200, isAvailable: true, isDemo: false, isFeatured: false, sortOrder: 0 });
  const order = mapOrder({ id: 'o', order_number: 'KDI-20261110000', status: 'placed', version: 1, subtotal_paise: 1200, delivery_fee_paise: 100, total_paise: 1300, customer_name: 'Name', customer_phone: 'Phone', delivery_address_line: 'Address', created_at: '2026-01-01', order_items: [{ diet: 'egg', menu_item_id: 'm', name: 'Dish', quantity: 1, unit_price_paise: 1200, line_total_paise: 1200 }], order_status_history: [{ status: 'accepted', created_at: '2026-01-02' }, { status: 'placed', created_at: '2026-01-01' }] }, slug);
  assert.equal(order.orderNumber, 'KDI-20261110000');
  assert.equal(order.lines[0].unitPricePaise, 1200);
  assert.equal(order.lines[0].diet, 'egg');
  assert.equal(order.delivery.addressLine, 'Address');
  assert.deepEqual(order.history?.map(entry => entry.status), ['placed', 'accepted']);
  assert.equal('location' in order, false, 'no pin stored');
  const base = { id: 'o', status: 'placed' as const, version: 1, subtotal_paise: 0, delivery_fee_paise: 0, total_paise: 0, customer_name: 'N', customer_phone: 'P', delivery_address_line: 'A', created_at: '2026-01-01', order_items: [] };
  assert.equal(mapOrder(base, slug).orderNumber, undefined, 'legacy rows never invent a number');
  assert.deepEqual(mapOrder({ ...base, latitude: 17.7, longitude: 73.4 }, slug).location, { latitude: 17.7, longitude: 73.4 });
  assert.equal('location' in mapOrder({ ...base, latitude: 17.7, longitude: null }, slug), false, 'a partial pin is ignored');
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
      return Response.json(method === 'DELETE' ? { id: 'item1' } : { diet: 'egg', id: 'item1', name: 'Dish', description: '', category_id: 'category-main', menu_categories: { name: 'Main', sort_order: 0 }, price_paise: 100, available: true, is_demo: true, is_featured: true, sort_order: -2, image_url: null });
    }
    throw new Error(`Unexpected request ${url}`);
  };
  try {
    const service = createMarketServices({ businessSlug: slug, audience: 'admin', config: { url: 'https://example.test', anonKey: 'sb_publishable_test' }, storage });
    await service.auth.signIn('admin@example.test', 'password');
    const item = { diet: 'egg' as const, name: 'Dish', description: '', categoryId: 'category-main', pricePaise: 100, isAvailable: true, isDemo: true, isFeatured: true, sortOrder: -2 };
    const saved = await service.saveMenuItem(item);
    assert.equal(saved.isFeatured, true); assert.equal(saved.sortOrder, -2);
    await service.saveMenuItem({ ...item, id: 'item1' }); await service.deleteMenuItem('item1');
    assert.equal(calls[0].body.diet, 'egg');
    assert.equal(calls[0].body.category_id, 'category-main'); assert.equal(calls[0].body.category, undefined);
    assert.match(calls[0].url.searchParams.get('select') ?? '', /menu_categories!menu_items_category_business_fk/);
    assert.equal(calls[0].body.is_featured, true); assert.equal(calls[0].body.sort_order, -2);
    assert.equal(calls[0].method, 'POST'); assert.equal(calls[0].body.business_id, 'tenant-id'); assert.equal(calls[0].body.is_demo, true);
    for (const call of calls.slice(1)) { assert.equal(call.url.searchParams.get('id'), 'eq.item1'); assert.equal(call.url.searchParams.get('business_id'), 'eq.tenant-id'); }
    assert.equal(calls[1].method, 'PATCH'); assert.equal(calls[1].body.business_id, undefined); assert.equal(calls[2].method, 'DELETE');
    await assert.rejects(service.saveMenuItem({ ...item, pricePaise: 1.5 }), /positive whole price/);
    await assert.rejects(service.saveMenuItem({ ...item, isDemo: undefined as never }), /sample and featured status/);
    for (const diet of [null, undefined, 'fish']) {
      await assert.rejects(service.saveMenuItem({ ...item, diet: diet as never }), /Choose Vegetarian/);
    }
    await service.saveMenuItem({ ...item, id: 'item1', diet: null });
    for (const sortOrder of [1.5, NaN, Infinity, -2147483649, 2147483648, undefined, '2']) {
      await assert.rejects(service.saveMenuItem({ ...item, sortOrder: sortOrder as never }), /whole item order/);
    }
    for (const isFeatured of [undefined, null, 'true', 1]) {
      await assert.rejects(service.saveMenuItem({ ...item, isFeatured: isFeatured as never }), /featured status/);
    }

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
    { table: 'menu_categories', event: '*', filter: 'business_id=eq.tenant-id' },
  ]);
  status?.('SUBSCRIBED'); for (const listener of listeners) listener.callback(); status?.('CHANNEL_ERROR'); status?.('SUBSCRIBED');
  assert.equal(refreshes, 7); assert.equal(errors, 1);
  cleanup(); listeners[0].callback(); status?.('SUBSCRIBED');
  assert.equal(removed, true); assert.equal(refreshes, 7);
});

test('open/closed is read, changed only by owners, and a closed refusal has its own error', async () => {
  const originalFetch = globalThis.fetch;
  const memory = new Map<string, string>();
  const storage = { getItem: (k: string) => memory.get(k) ?? null, setItem: (k: string, v: string) => { memory.set(k, v); }, removeItem: (k: string) => { memory.delete(k); } };
  const token = `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: 'user1', session_id: 'owner-session-1', role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.signature`;
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
    const item = { id: 'm', businessId: slug, name: 'Dish', description: '', category: 'Main', categoryId: 'category-main', categorySortOrder: 0, pricePaise: 100, isAvailable: true, isDemo: false, isFeatured: false, sortOrder: 0 };
    await assert.rejects(customer.placeOrder({ pricing: { lines: [], delivery_fee_paise: 0, min_order_paise: 0, subtotal_paise: 0, total_paise: 0 }, lines: [{ item, quantity: 1 }], delivery: { name: 'N', phone: '1', addressLine: 'A' }, location: { latitude: 0.5, longitude: 0.5, accuracy: 10, capturedAtISO: new Date().toISOString() }, idempotencyKey: 'key' }), (e: unknown) => e instanceof ServiceError && e.code === 'NOT_ACCEPTING_ORDERS');
    customer.dispose();
  } finally { globalThis.fetch = originalFetch; }
});

test('owner switch fences a held membership check to its initiating owner and auth session', async t => {
  const originalFetch = globalThis.fetch;
  const jwt = (sub: string, session_id: string, version: number) => `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub, session_id, version, role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.sig`;
  for (const scenario of ['other-owner', 'new-session', 'matching-refresh', 'disposed'] as const) await t.test(scenario, async () => {
    const initial = jwt('owner-a', 'session-a', 1);
    let activeUser = 'owner-a', activeToken = initial;
    let release!: () => void, arrived!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const membershipArrived = new Promise<void>(resolve => { arrived = resolve; });
    const rpcs: { auth: string | null; body: unknown }[] = [];
    const memory = new Map<string, string>();
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/auth/v1/token') return Response.json({ access_token: activeToken, refresh_token: 'refresh', expires_in: 3600, token_type: 'bearer', user: { id: activeUser, aud: 'authenticated' } });
      if (url.pathname === '/auth/v1/logout') return new Response(null, { status: 204 });
      if (url.pathname === '/auth/v1/user') {
        const token = new Headers(init?.headers).get('Authorization')!.slice(7);
        const sub = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).sub;
        return Response.json({ id: sub, aud: 'authenticated' });
      }
      if (url.pathname === '/rest/v1/businesses') return Response.json({ id: 'business', slug, name: 'Business', delivery_fee_paise: 0, min_order_paise: 0, is_demo: false, ordering_enabled: true, accepting_orders: true });
      if (url.pathname === '/rest/v1/business_memberships') {
        assert.equal(new Headers(init?.headers).get('Authorization'), `Bearer ${initial}`, 'membership lookup started with owner A');
        arrived(); await held; return Response.json({ role: 'admin' });
      }
      if (url.pathname === '/rest/v1/rpc/set_accepting_orders') {
        rpcs.push({ auth: new Headers(init?.headers).get('Authorization'), body: JSON.parse(String(init?.body)) });
        return Response.json({ business_id: 'business', accepting_orders: false });
      }
      throw new Error(`Unexpected owner-session fixture ${url}`);
    };
    const service = createMarketServices({ businessSlug: slug, audience: 'admin', config: { url: 'https://example.test', anonKey: 'sb_publishable_test' }, storage: { getItem: key => memory.get(key) ?? null, setItem: (key, value) => { memory.set(key, value); }, removeItem: key => { memory.delete(key); } } });
    try {
      await service.auth.signIn('owner-a@example.test', 'password');
      const pending = service.setAcceptingOrders(false).then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
      await membershipArrived;
      if (scenario === 'disposed') service.dispose();
      else {
        if (scenario === 'other-owner') { await service.auth.signOut(); activeUser = 'owner-b'; activeToken = jwt(activeUser, 'session-b', 1); }
        else activeToken = jwt(activeUser, scenario === 'new-session' ? 'session-other' : 'session-a', 2);
        await service.auth.signIn(`${activeUser}@example.test`, 'password');
      }
      release(); const result = await pending;
      if (scenario === 'matching-refresh') {
        assert.equal(result.error, undefined); assert.equal(result.value, false);
        assert.deepEqual(rpcs, [{ auth: `Bearer ${activeToken}`, body: { p_business_slug: slug, p_accepting: false } }], 'matching refreshed credentials authorize exactly the initiating owner request');
      } else {
        assert.ok(result.error instanceof ServiceError && result.error.code === 'SESSION_CHANGED', 'stale owner/session must be rejected before dispatch');
        assert.equal(rpcs.length, 0, 'no switch mutation may be attributed to the next owner or auth session');
      }
    } finally { release(); service.dispose(); globalThis.fetch = originalFetch; }
  });
});

test('demo diet stays unknown and explicit menu marks map for both restaurants', async () => {
  for (const businessSlug of ['ammu-sammu', 'kokani-dine-inn'] as const) {
    const service = createMarketServices({ businessSlug, audience: 'customer', config: {} });
    assert.equal((await service.getMenu())[0].diet, null);
    for (const diet of ['veg', 'egg', 'non_veg', null] as const) {
      assert.equal(mapMenu({ id: 'm', name: 'Dish', description: null, category_id: 'category-main', menu_categories: { name: 'Main', sort_order: 0 }, price_paise: 100, available: true, is_demo: false, is_featured: false, sort_order: 0, image_url: null, diet }, businessSlug).diet, diet);
    }
    service.dispose();
  }
});

test('revised pricing validates every line and amount before releasing the uncertain attempt', async () => {
  const { validateRevisedPricing } = await import('./index.ts');
  const lines = [{ item: { id: 'dish', businessId: slug, name: 'Dish', description: '', category: 'Main', categoryId: 'category-main', categorySortOrder: 0, pricePaise: 100, isAvailable: true, isDemo: false, isFeatured: false, sortOrder: 0 }, quantity: 2 }];
  const valid = { lines: [{ menu_item_id: 'dish', quantity: 2, unit_price_paise: 150, line_total_paise: 300 }], delivery_fee_paise: 40, min_order_paise: 500, subtotal_paise: 300, total_paise: 340 };
  assert.deepEqual(validateRevisedPricing(valid, lines), valid, 'below minimum is a valid revised quote');
  for (const value of [null, {}, { ...valid, total_paise: 1 }, { ...valid, delivery_fee_paise: -1 }, { ...valid, min_order_paise: '500' }, { ...valid, subtotal_paise: 1 }, { ...valid, lines: [] }, { ...valid, lines: [{ ...valid.lines[0], menu_item_id: 'foreign' }] }, { ...valid, lines: [{ ...valid.lines[0], quantity: 3 }] }, { ...valid, lines: [{ ...valid.lines[0], unit_price_paise: 0 }] }, { ...valid, lines: [{ ...valid.lines[0], line_total_paise: 1 }] }]) {
    assert.throws(() => validateRevisedPricing(value, lines), (e: unknown) => e instanceof ServiceError && e.code === 'INVALID_RESPONSE');
  }
});

test('checkout passes frozen terms and treats only validated no-order responses as revised pricing', async () => {
  const { PricingChangedError } = await import('./index.ts');
  const originalFetch = globalThis.fetch;
  const item = { id: '20000000-0000-4000-8000-000000000001', businessId: slug, name: 'Dish', description: '', category: 'Main', categoryId: 'category-main', categorySortOrder: 0, pricePaise: 100, isAvailable: true, isDemo: false, isFeatured: false, sortOrder: 0 };
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


test('catalog reads scope the business and request stable item ordering', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/businesses')) return Response.json({ id: 'tenant', slug, name: 'Business', delivery_fee_paise: 0, min_order_paise: 0, is_demo: false, ordering_enabled: false, accepting_orders: false });
    assert.equal(url.pathname, '/rest/v1/menu_items');
    assert.equal(url.searchParams.get('business_id'), 'eq.tenant');
    assert.equal(url.searchParams.get('order'), 'sort_order.asc,name.asc,id.asc');
    return Response.json([]);
  };
  const service = createMarketServices({ businessSlug: slug, audience: 'customer', config: { url: 'https://example.test', anonKey: 'sb_publishable_test' } });
  try { assert.deepEqual(await service.getMenu(), []); }
  finally { service.dispose(); globalThis.fetch = original; }
});

test('category reads and owner CRUD use current business and report actionable conflicts', async () => {
  const original = globalThis.fetch;
  const calls: { method: string; url: URL; body: Record<string, unknown> }[] = [];
  let conflict = '';
  const token = `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: 'category-owner', role: 'authenticated', exp: Math.floor(Date.now()/1000)+3600 })).toString('base64url')}.signature`;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/auth/v1/token')) return Response.json({ access_token: token, refresh_token: 'refresh', expires_in: 3600, token_type: 'bearer', user: { id: 'category-owner', aud: 'authenticated' } });
    if (url.pathname.endsWith('/businesses')) return Response.json({ id: 'tenant-category', slug, name: 'Business', delivery_fee_paise: 0, min_order_paise: 0, is_demo: false, ordering_enabled: true });
    if (url.pathname.endsWith('/auth/v1/user')) return Response.json({ id: 'category-owner' });
    if (url.pathname.endsWith('/business_memberships')) return Response.json({ role: 'admin' });
    if (url.pathname.endsWith('/menu_categories')) {
      const method = init?.method ?? 'GET', body = init?.body ? JSON.parse(String(init.body)) : {};
      calls.push({ method, url, body });
      assert.equal(url.searchParams.get('business_id'), method === 'POST' ? null : 'eq.tenant-category');
      if (conflict) return new Response(JSON.stringify({ code: conflict, message: 'Synthetic conflict' }), { status: 409 });
      const row = { id: 'category-1', name: 'All', sort_order: -3 };
      return Response.json(method === 'GET' ? [row] : method === 'DELETE' ? { id: row.id } : row);
    }
    throw new Error('Unexpected request ' + url);
  };
  const memory = new Map<string, string>();
  const service = createMarketServices({ businessSlug: slug, audience: 'admin', config: { url: 'https://category.example.test', anonKey: 'sb_publishable_test' }, storage: { getItem: key => memory.get(key) ?? null, setItem: (key, value) => { memory.set(key, value); }, removeItem: key => { memory.delete(key); } } });
  try {
    await service.auth.signIn('owner@example.test', 'password');
    await assert.rejects(service.saveCategory({ name: ' ', sortOrder: 0 }), /1 to 100/);
    await assert.rejects(service.saveCategory({ name: 'All', sortOrder: 1.5 }), /whole order/);
    const groups = await service.getCategories();
    assert.equal(groups[0].name, 'All'); assert.equal(groups[0].sortOrder, -3);
    assert.equal(calls[0].url.searchParams.get('order'), 'sort_order.asc,name.asc,id.asc');
    await service.saveCategory({ name: ' All ', sortOrder: -3 });
    assert.deepEqual(calls[1].body, { name: 'All', sort_order: -3, business_id: 'tenant-category' });
    await service.saveCategory({ id: 'category-1', name: 'All', sortOrder: -3 });
    assert.equal(calls[2].url.searchParams.get('id'), 'eq.category-1');
    assert.deepEqual(calls[2].body, { name: 'All', sort_order: -3 });
    await service.deleteCategory('category-1');
    assert.equal(calls[3].url.searchParams.get('id'), 'eq.category-1');
    conflict = '23505';
    await assert.rejects(service.saveCategory({ name: 'All', sortOrder: 0 }), (error: unknown) => error instanceof ServiceError && error.code === 'CATEGORY_DUPLICATE');
    conflict = '42501';
    await assert.rejects(service.saveCategory({ name: 'All', sortOrder: 0 }), (error: unknown) => error instanceof ServiceError && error.code === 'ADMIN_REQUIRED');
    conflict = '23503';
    await assert.rejects(service.deleteCategory('category-1'), (error: unknown) => error instanceof ServiceError && error.code === 'CATEGORY_IN_USE');
  } finally { service.dispose(); globalThis.fetch = original; }
});

test('owner reads carry history name snapshots; customer reads request status and time only', async () => {
  const original = globalThis.fetch;
  const selects: Record<string, string> = {};
  const token = `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: 'history-customer', role: 'authenticated', exp: Math.floor(Date.now()/1000)+3600 })).toString('base64url')}.signature`;
  const row = { id: '49800000-0000-4000-8000-0000000000a1', status: 'preparing', version: 3, subtotal_paise: 100, delivery_fee_paise: 0, total_paise: 100, customer_name: 'Name', customer_phone: '123', delivery_address_line: 'Khed', created_at: '2026-11-16T10:00:00Z', order_items: [] };
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const audience = String(url.host).startsWith('owner') ? 'admin' : 'customer';
    if (url.pathname.endsWith('/auth/v1/token')) return Response.json({ access_token: token, refresh_token: 'refresh', expires_in: 3600, token_type: 'bearer', user: { id: 'history-customer', aud: 'authenticated' } });
    if (url.pathname.endsWith('/auth/v1/user')) return Response.json({ id: 'history-customer' });
    if (url.pathname.endsWith('/businesses')) return Response.json({ id: 'tenant-history', slug, name: 'Business', delivery_fee_paise: 0, min_order_paise: 0, is_demo: false, ordering_enabled: true, accepting_orders: true });
    assert.equal(url.pathname, '/rest/v1/orders');
    assert.equal(init?.method ?? 'GET', 'GET');
    selects[audience] = url.searchParams.get('select') ?? '';
    return Response.json(audience === 'admin'
      ? [{ ...row, order_status_history: [{ status: 'preparing', created_at: '2026-11-16T10:02:00Z', order_status_actors: [{ actor_name: 'Ravi' }] }, { status: 'placed', created_at: '2026-11-16T10:00:00Z', order_status_actors: null }, { status: 'accepted', created_at: '2026-11-16T10:01:00Z', order_status_actors: { actor_name: 'Asha Kadam' } }] }]
      : [{ ...row, order_status_history: [{ status: 'placed', created_at: '2026-11-16T10:00:00Z' }, { status: 'accepted', created_at: '2026-11-16T10:01:00Z' }] }]);
  };
  const memory = new Map<string, string>();
  const storage = { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => { memory.set(key, value); }, removeItem: (key: string) => { memory.delete(key); } };
  const owner = createMarketServices({ businessSlug: slug, audience: 'admin', config: { url: 'https://owner.example.test', anonKey: 'sb_publishable_test' }, storage });
  const customer = createMarketServices({ businessSlug: slug, audience: 'customer', config: { url: 'https://customer.example.test', anonKey: 'sb_publishable_test' }, storage });
  try {
    const [order] = await owner.getOrders();
    assert.deepEqual(order.history, [{ status: 'placed', createdAtISO: '2026-11-16T10:00:00Z' }, { status: 'accepted', createdAtISO: '2026-11-16T10:01:00Z', actorName: 'Asha Kadam' }, { status: 'preparing', createdAtISO: '2026-11-16T10:02:00Z', actorName: 'Ravi' }]);
    assert.match(selects.admin, /order_status_history\(status,created_at,order_status_actors\(actor_name\)\)/);
    await customer.auth.signIn('customer@example.test', 'password');
    const [own] = await customer.getOrders();
    assert.equal(own.history?.length, 2);
    assert.match(selects.customer, /order_status_history\(status,created_at\)/);
    assert.doesNotMatch(selects.customer, /order_status_actors|changed_by|order_status_history\(\*\)/);
  } finally { owner.dispose(); customer.dispose(); globalThis.fetch = original; }
});

test('owner menu switches send availability only and reorders map stale lists to a reload', async () => {
  const original = globalThis.fetch;
  const calls: { method: string; path: string; body: Record<string, unknown>; query: URLSearchParams }[] = [];
  let rpcError = '';
  const token = `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: 'menu-owner', role: 'authenticated', exp: Math.floor(Date.now()/1000)+3600 })).toString('base64url')}.signature`;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/auth/v1/token')) return Response.json({ access_token: token, refresh_token: 'refresh', expires_in: 3600, token_type: 'bearer', user: { id: 'menu-owner', aud: 'authenticated' } });
    if (url.pathname.endsWith('/auth/v1/user')) return Response.json({ id: 'menu-owner' });
    if (url.pathname.endsWith('/businesses')) return Response.json({ id: 'tenant-menu', slug, name: 'Business', delivery_fee_paise: 0, min_order_paise: 0, is_demo: false, ordering_enabled: true });
    if (url.pathname.endsWith('/business_memberships')) return Response.json({ role: 'admin' });
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    calls.push({ method: init?.method ?? 'GET', path: url.pathname, body, query: url.searchParams });
    if (url.pathname.startsWith('/rest/v1/rpc/')) return rpcError ? new Response(JSON.stringify({ code: rpcError, message: 'Synthetic' }), { status: 400 }) : Response.json(2);
    if (url.pathname.endsWith('/menu_items')) return Response.json({ diet: 'veg', id: 'dish-1', name: 'Veg thali', description: null, category_id: 'cat-1', menu_categories: { name: 'Thalis', sort_order: 0 }, price_paise: 18000, available: false, is_demo: false, is_featured: false, sort_order: 1, image_url: null });
    throw new Error('Unexpected request ' + url);
  };
  const memory = new Map<string, string>();
  const service = createMarketServices({ businessSlug: slug, audience: 'admin', config: { url: 'https://menu.example.test', anonKey: 'sb_publishable_test' }, storage: { getItem: key => memory.get(key) ?? null, setItem: (key, value) => { memory.set(key, value); }, removeItem: key => { memory.delete(key); } } });
  try {
    await service.auth.signIn('owner@example.test', 'password');
    const item = await service.setMenuItemAvailability('dish-1', false);
    assert.equal(item.isAvailable, false);
    assert.deepEqual(calls[0].body, { available: false }, 'never resend other dish fields');
    assert.equal(calls[0].method, 'PATCH');
    assert.equal(calls[0].query.get('business_id'), 'eq.tenant-menu');
    await assert.rejects(service.setMenuItemAvailability('dish-1', 'no' as unknown as boolean), /available/);
    await service.reorderMenuItems('cat-1', ['dish-2', 'dish-1']);
    assert.deepEqual(calls.at(-1)?.body, { p_business_slug: slug, p_category_id: 'cat-1', p_item_ids: ['dish-2', 'dish-1'] });
    await service.reorderCategories(['cat-2', 'cat-1']);
    assert.deepEqual(calls.at(-1)?.body, { p_business_slug: slug, p_category_ids: ['cat-2', 'cat-1'] });
    const before = calls.length;
    await assert.rejects(service.reorderMenuItems('cat-1', ['dish-1', 'dish-1']), (e: unknown) => e instanceof ServiceError && e.code === 'INVALID_ORDER');
    assert.equal(calls.length, before, 'duplicates are refused before any request');
    rpcError = '40001';
    await assert.rejects(service.reorderMenuItems('cat-1', ['dish-1']), (e: unknown) => e instanceof ServiceError && e.code === 'MENU_CHANGED');
    rpcError = '42501';
    await assert.rejects(service.reorderCategories(['cat-1']), (e: unknown) => e instanceof ServiceError && e.code === 'ADMIN_REQUIRED');
  } finally { service.dispose(); globalThis.fetch = original; }
});

test('owner day summary maps the RPC, validates the day and reports lost access', async () => {
  const original = globalThis.fetch;
  const bodies: Record<string, unknown>[] = [];
  let rpcError = '';
  const token = `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: 'summary-owner', role: 'authenticated', exp: Math.floor(Date.now()/1000)+3600 })).toString('base64url')}.signature`;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/auth/v1/token')) return Response.json({ access_token: token, refresh_token: 'refresh', expires_in: 3600, token_type: 'bearer', user: { id: 'summary-owner', aud: 'authenticated' } });
    if (url.pathname.endsWith('/auth/v1/user')) return Response.json({ id: 'summary-owner' });
    if (url.pathname.endsWith('/businesses')) return Response.json({ id: 'tenant-summary', slug, name: 'Business', delivery_fee_paise: 0, min_order_paise: 0, is_demo: false, ordering_enabled: true });
    if (url.pathname.endsWith('/business_memberships')) return Response.json({ role: 'admin' });
    assert.equal(url.pathname, '/rest/v1/rpc/daily_summary');
    bodies.push(JSON.parse(String(init?.body ?? '{}')));
    if (rpcError) return new Response(JSON.stringify({ code: rpcError, message: 'Synthetic' }), { status: 400 });
    return Response.json({ date: '2026-11-10', collected_paise: 43000, delivered_count: 1, outstanding_paise: 31000, outstanding_count: 2, placed_count: 4, cancelled_count: 1, top_dishes: [{ name: 'Misal pav', quantity: 3 }] });
  };
  const memory = new Map<string, string>();
  const service = createMarketServices({ businessSlug: slug, audience: 'admin', config: { url: 'https://summary.example.test', anonKey: 'sb_publishable_test' }, storage: { getItem: key => memory.get(key) ?? null, setItem: (key, value) => { memory.set(key, value); }, removeItem: key => { memory.delete(key); } } });
  try {
    await service.auth.signIn('owner@example.test', 'password');
    assert.deepEqual(await service.getDailySummary('2026-11-10'), { dateISO: '2026-11-10', collectedPaise: 43000, deliveredCount: 1, outstandingPaise: 31000, outstandingCount: 2, placedCount: 4, cancelledCount: 1, topDishes: [{ name: 'Misal pav', quantity: 3 }] });
    assert.deepEqual(bodies.at(-1), { p_business_slug: slug, p_date: '2026-11-10' });
    await service.getDailySummary();
    assert.deepEqual(bodies.at(-1), { p_business_slug: slug }, 'no day means today on the server, in India time');
    const before = bodies.length;
    for (const bad of ['2026-02-30', '10-11-2026', '2026-11-1', '']) await assert.rejects(service.getDailySummary(bad), (e: unknown) => e instanceof ServiceError && e.code === 'INVALID_DATE');
    assert.equal(bodies.length, before, 'invalid days never reach the server');
    rpcError = '42501';
    await assert.rejects(service.getDailySummary('2026-11-10'), (e: unknown) => e instanceof ServiceError && e.code === 'ADMIN_REQUIRED');
  } finally { service.dispose(); globalThis.fetch = original; }
});

test('owner display name reads only the signed-in owner row and falls back to null', async () => {
  const original = globalThis.fetch;
  let reply: unknown = { display_name: 'Suresh Pawar' }; let query: URLSearchParams | undefined;
  const token = `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: 'name-owner', role: 'authenticated', exp: Math.floor(Date.now()/1000)+3600 })).toString('base64url')}.signature`;
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/auth/v1/token')) return Response.json({ access_token: token, refresh_token: 'refresh', expires_in: 3600, token_type: 'bearer', user: { id: 'name-owner', aud: 'authenticated' } });
    if (url.pathname.endsWith('/auth/v1/user')) return Response.json({ id: 'name-owner' });
    if (url.pathname.endsWith('/businesses')) return Response.json({ id: 'tenant-name', slug, name: 'Business', delivery_fee_paise: 0, min_order_paise: 0, is_demo: false, ordering_enabled: true });
    assert.equal(url.pathname, '/rest/v1/business_memberships'); query = url.searchParams;
    return Response.json(reply);
  };
  const memory = new Map<string, string>();
  const service = createMarketServices({ businessSlug: slug, audience: 'admin', config: { url: 'https://name.example.test', anonKey: 'sb_publishable_test' }, storage: { getItem: key => memory.get(key) ?? null, setItem: (key, value) => { memory.set(key, value); }, removeItem: key => { memory.delete(key); } } });
  try {
    await service.auth.signIn('owner@example.test', 'password');
    assert.equal(await service.getOwnerDisplayName(), 'Suresh Pawar');
    assert.equal(query?.get('select'), 'display_name');
    assert.equal(query?.get('user_id'), 'eq.name-owner'); assert.equal(query?.get('business_id'), 'eq.tenant-name');
    reply = null; assert.equal(await service.getOwnerDisplayName(), null);
    reply = { display_name: '  ' }; assert.equal(await service.getOwnerDisplayName(), null);
    reply = { display_name: ' Suresh ' }; assert.equal(await service.getOwnerDisplayName(), 'Suresh');
  } finally { service.dispose(); globalThis.fetch = original; }
});

test('saved-address orders map their snapshot; typed-address and partial rows do not invent one (#48)', () => {
  const base = { id: 'o', status: 'placed' as const, version: 1, subtotal_paise: 0, delivery_fee_paise: 0, total_paise: 0, customer_name: 'N', customer_phone: 'P', delivery_address_line: '12, Station Road', created_at: '2026-01-01', order_items: [], latitude: 17.7, longitude: 73.4 };
  const snapshot = { saved_address_id: '74800000-0000-4000-8000-000000000001', address_label: 'other', address_custom_label: 'Aai', address_house: '12', address_street_area: 'Station Road', address_landmark: null, address_location_source: 'pin', placed_from_distance_m: 2400 };
  const order = mapOrder({ ...base, ...snapshot }, slug);
  assert.deepEqual(order.address, { label: 'other', customLabel: 'Aai', house: '12', streetArea: 'Station Road', locationSource: 'pin' });
  assert.equal(order.placedFromDistanceM, 2400);
  assert.equal(mapOrder({ ...base, ...snapshot, placed_from_distance_m: null }, slug).placedFromDistanceM, null, 'unknown phone distance stays unknown');
  assert.equal(mapOrder({ ...base, ...snapshot, placed_from_distance_m: -1 }, slug).placedFromDistanceM, null);
  assert.equal('address' in mapOrder(base, slug), false, 'typed-address order');
  assert.equal('address' in mapOrder({ ...base, ...snapshot, address_label: 'office' }, slug), false, 'unknown label is not trusted');
  assert.equal('address' in mapOrder({ ...base, ...snapshot, address_house: null }, slug), false, 'partial snapshot is not trusted');
});

test('saved addresses: list with server area/distance, versioned save, delete, and saved-pin checkout (#48)', async () => {
  const originalFetch = globalThis.fetch;
  const token = `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: 'user1', session_id: 'customer-session-1', role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.signature`;
  const id = '74800000-0000-4000-8000-000000000001';
  const requests: { method: string; path: string; query: string; body: unknown }[] = [];
  let listed: unknown = [{ id, label: 'home', custom_label: null, house: '12', street_area: 'Station Road', landmark: 'Near temple', latitude: 17.7, longitude: 73.4, location_source: 'pin', version: 3, updated_at: '2026-11-16T10:00:00Z', in_area: true, distance_m: 1800 }];
  let updated: unknown = { id, version: 4 };
  let placeError: Record<string, unknown> | null = null;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/auth/v1/token')) return Response.json({ access_token: token, refresh_token: 'refresh', expires_in: 3600, token_type: 'bearer', user: { id: 'user1', aud: 'authenticated' } });
    requests.push({ method: init?.method ?? 'GET', path: url.pathname, query: url.search, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url.pathname.endsWith('/rpc/list_addresses')) return Response.json(listed);
    if (url.pathname.endsWith('/rpc/place_order')) return placeError ? Response.json(placeError, { status: 400 }) : Response.json({ outcome: 'placed', id: '40000000-0000-4000-8000-000000000001' });
    if (url.pathname.endsWith('/customer_addresses') && init?.method === 'POST') return Response.json({ id, version: 1 }, { status: 201 });
    if (url.pathname.endsWith('/customer_addresses') && init?.method === 'PATCH') return Response.json(updated === null ? [] : [updated]);
    if (url.pathname.endsWith('/customer_addresses') && init?.method === 'DELETE') return new Response(null, { status: 204 });
    throw new Error(`Unexpected request ${init?.method} ${url}`);
  };
  try {
    const customer = createMarketServices({ businessSlug: slug, audience: 'customer', config: { url: 'https://example.test', anonKey: 'sb_publishable_test' }, storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } });
    await customer.auth.signIn('customer@example.test', 'password');
    assert.deepEqual(await customer.listAddresses(), [{ id, label: 'home', house: '12', streetArea: 'Station Road', landmark: 'Near temple', latitude: 17.7, longitude: 73.4, locationSource: 'pin', version: 3, updatedAtISO: '2026-11-16T10:00:00Z', inArea: true, distanceM: 1800 }]);
    assert.deepEqual(requests.at(-1)?.body, { p_business_slug: slug }, 'area and distance are for this restaurant');
    listed = [{ id, label: 'home' }];
    await assert.rejects(customer.listAddresses(), (e: unknown) => e instanceof ServiceError && e.code === 'INVALID_RESPONSE');

    const draft = { label: 'other' as const, customLabel: ' Aai ', house: ' 12 ', streetArea: 'Station Road', latitude: 17.7, longitude: 73.4, locationSource: 'gps' as const };
    assert.deepEqual(await customer.saveAddress(draft), { id, version: 1 });
    assert.deepEqual(requests.at(-1)?.body, { label: 'other', custom_label: 'Aai', house: '12', street_area: 'Station Road', landmark: null, latitude: 17.7, longitude: 73.4, location_source: 'gps' }, 'owner and version are never sent');
    const before = requests.length;
    await assert.rejects(customer.saveAddress({ ...draft, house: ' ' }), (e: unknown) => e instanceof Error && 'fields' in e && 'house' in (e as { fields: object }).fields);
    assert.equal(requests.length, before, 'invalid drafts make no request');
    assert.deepEqual(await customer.saveAddress(draft, { id, version: 3 }), { id, version: 4 });
    assert.match(requests.at(-1)?.query ?? '', /id=eq\.74800000-0000-4000-8000-000000000001/);
    assert.match(requests.at(-1)?.query ?? '', /version=eq\.3/, 'edit only the version that was opened');
    updated = null;
    await assert.rejects(customer.saveAddress(draft, { id, version: 3 }), (e: unknown) => e instanceof ServiceError && e.code === 'ADDRESS_CHANGED');
    await customer.deleteAddress(id);
    assert.equal(requests.at(-1)?.method, 'DELETE');
    await assert.rejects(customer.deleteAddress('nope'), (e: unknown) => e instanceof ServiceError && e.code === 'INVALID_ADDRESS');

    const item = { id: '20000000-0000-4000-8000-000000000001', businessId: slug, name: 'Dish', description: '', category: 'Main', categoryId: 'category-main', categorySortOrder: 0, pricePaise: 100, isAvailable: true, isDemo: false, isFeatured: false, sortOrder: 0 };
    const pricing = { lines: [{ menu_item_id: item.id, quantity: 1, unit_price_paise: 100, line_total_paise: 100 }], delivery_fee_paise: 0, min_order_paise: 0, subtotal_paise: 100, total_paise: 100 };
    const input = { pricing, lines: [{ item, quantity: 1 }], delivery: { name: 'Priya', phone: '+919876543210', addressLine: 'ignored' }, location: null, idempotencyKey: '64800000-0000-4000-8000-000000000001', savedAddress: { id, version: 3 } };
    placeError = { code: 'PT412', message: 'saved address changed', details: null, hint: null };
    await assert.rejects(customer.placeOrder(input), (e: unknown) => e instanceof ServiceError && e.code === 'ADDRESS_CHANGED');
    const sent = requests.at(-1)?.body as Record<string, unknown>;
    assert.deepEqual(sent.p_delivery, { name: 'Priya', phone: '+919876543210', address_id: id, address_version: 3 }, 'no typed address with a saved one');
    assert.equal(sent.p_location, null, 'no phone fix is fine');
    placeError = { code: '22023', message: 'delivery unavailable', details: null, hint: null };
    await assert.rejects(customer.placeOrder({ ...input, location: { latitude: 17.71, longitude: 73.41, accuracy: 900, capturedAtISO: '2026-11-16T10:00:00Z' } }), (e: unknown) => e instanceof ServiceError && e.code === 'OUTSIDE_DELIVERY_AREA');
    assert.deepEqual((requests.at(-1)?.body as Record<string, unknown>).p_location, { latitude: 17.71, longitude: 73.41, accuracy: 900, captured_at: '2026-11-16T10:00:00Z' }, 'phone fix is sent as-is');
    const calls = requests.length;
    await assert.rejects(customer.placeOrder({ ...input, savedAddress: { id, version: 0 } }), (e: unknown) => e instanceof ServiceError && e.code === 'INVALID_ADDRESS');
    await assert.rejects(customer.placeOrder({ ...input, savedAddress: undefined }), (e: unknown) => e instanceof ServiceError && e.code === 'LOCATION_REQUIRED', 'typed address still needs GPS');
    assert.equal(requests.length, calls, 'refused before any request');
    customer.dispose();
  } finally { globalThis.fetch = originalFetch; }
});
