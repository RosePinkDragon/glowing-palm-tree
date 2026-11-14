import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMarketServices, ServiceError, type OrderCursor, type OrderPageOptions } from './index.ts';

const customerA = '20000000-0000-4000-8000-000000000001';
const customerB = '20000000-0000-4000-8000-000000000002';
const businessA = '10000000-0000-4000-8000-000000000001';
const businessB = '10000000-0000-4000-8000-000000000002';
const orderId = (n: number) => `30000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const timestamp = '2026-11-14T10:00:00.123456Z';
const row = (n: number, status = 'delivered', createdAt = timestamp, customer = customerA, business = businessA) => ({
  id: orderId(n), status, version: 1, customer_id: customer, business_id: business,
  subtotal_paise: 12000, delivery_fee_paise: 1000, total_paise: 13000,
  customer_name: 'Synthetic customer', customer_phone: '9000000000', delivery_address_line: 'Synthetic address', created_at: createdAt,
  order_items: [{ menu_item_id: '40000000-0000-4000-8000-000000000001', diet: 'veg', name: 'Synthetic dish', quantity: 1, unit_price_paise: 12000, line_total_paise: 12000 }],
  order_status_history: [{ status, created_at: createdAt }],
});
type Row = ReturnType<typeof row>;
type Service = ReturnType<typeof createMarketServices>;
const code = (expected: string) => (error: unknown) => error instanceof ServiceError && error.code === expected;

/** Exercise the installed SDK's outgoing requests, with a deterministic HTTP fixture. */
async function fixture(run: (f: {
  service: Service; rows: Row[]; queries: URL[]; create: (audience?: 'customer' | 'admin', slug?: 'ammu-sammu' | 'kokani-dine-inn') => Service;
  hold: (path: 'orders' | 'businesses' | 'user') => Promise<() => void>; failOrders: () => void;
}) => Promise<void>) {
  const originalFetch = globalThis.fetch;
  const services: Service[] = [], queries: URL[] = [], rows: Row[] = [];
  let heldPath: string | undefined, blocked: Promise<void> | undefined, unblock: (() => void) | undefined, entered: (() => void) | undefined;
  let ordersFail = false;
  const token = (id: string) => `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: id, role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.signature`;
  const userFrom = (headers: HeadersInit | undefined) => {
    const auth = new Headers(headers).get('authorization') ?? '';
    const claim = auth.split('.')[1];
    return claim ? JSON.parse(Buffer.from(claim, 'base64url').toString()).sub as string : undefined;
  };
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (heldPath && url.pathname.endsWith('/' + heldPath)) { heldPath = undefined; entered?.(); await blocked; }
    if (url.pathname.endsWith('/token')) {
      const id = JSON.parse(String(init?.body)).email === 'other@example.test' ? customerB : customerA;
      return Response.json({ access_token: token(id), refresh_token: 'synthetic-refresh', expires_in: 3600, token_type: 'bearer', user: { id, aud: 'authenticated' } });
    }
    if (url.pathname.endsWith('/logout')) return new Response(null, { status: 204 });
    if (url.pathname.endsWith('/user')) {
      const id = userFrom(init?.headers);
      return id ? Response.json({ id, aud: 'authenticated' }) : Response.json({ message: 'Sign in required' }, { status: 401 });
    }
    if (url.pathname.endsWith('/businesses')) {
      const slug = url.searchParams.get('slug')?.slice(3);
      return Response.json({ id: slug === 'kokani-dine-inn' ? businessB : businessA, slug, name: 'Synthetic business', delivery_fee_paise: 1000, min_order_paise: 0, is_demo: false, ordering_enabled: true });
    }
    if (url.pathname.endsWith('/orders')) {
      queries.push(url);
      if (ordersFail) return Response.json({ message: 'Synthetic order load failure', code: 'TEST_FAILURE' }, { status: 400 });
      assert.equal(init?.method ?? 'GET', 'GET');
      const owner = url.searchParams.get('customer_id')?.slice(3), business = url.searchParams.get('business_id')?.slice(3);
      assert.ok(owner && business, 'both ownership and restaurant filters must be sent');
      assert.equal(owner, userFrom(init?.headers), 'ownership comes from the verified authenticated user');
      let result = rows.filter(r => r.customer_id === owner && r.business_id === business);
      const status = url.searchParams.get('status');
      if (status) {
        assert.equal(status, 'in.(placed,accepted,preparing,out_for_delivery)');
        result = result.filter(r => ['placed', 'accepted', 'preparing', 'out_for_delivery'].includes(r.status));
      }
      const cursor = url.searchParams.get('or');
      if (cursor) {
        const parts = /^\(created_at\.lt\.([^,]+),and\(created_at\.eq\.([^,]+),id\.lt\.([^)]+)\)\)$/.exec(cursor);
        assert.ok(parts, 'cursor is a strict two-column PostgREST filter');
        assert.equal(parts[1], parts[2]);
        result = result.filter(r => r.created_at < parts[1] || (r.created_at === parts[1] && r.id < parts[3]));
      }
      const id = url.searchParams.get('id');
      if (id) return Response.json(result.find(r => r.id === id.slice(3)) ?? null);
      assert.equal(url.searchParams.get('order'), 'created_at.desc,id.desc');
      assert.equal(url.searchParams.has('offset'), false, 'history must not use offset pagination');
      result.sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
      return Response.json(result.slice(0, Number(url.searchParams.get('limit'))));
    }
    throw new Error(`Unexpected synthetic request ${url.pathname}`);
  };
  const create = (audience: 'customer' | 'admin' = 'customer', slug: 'ammu-sammu' | 'kokani-dine-inn' = 'ammu-sammu') => {
    const values = new Map<string, string>();
    const service = createMarketServices({ businessSlug: slug, audience, config: { url: 'https://customer-orders.test', anonKey: 'sb_publishable_test' }, storage: {
      getItem: k => values.get(k) ?? null, setItem: (k, v) => { values.set(k, v); }, removeItem: k => { values.delete(k); },
    } });
    services.push(service); return service;
  };
  const service = create();
  try {
    await service.auth.signIn('customer@example.test', 'synthetic-password');
    await run({ service, rows, queries, create, failOrders: () => { ordersFail = true; }, hold: async path => {
      heldPath = path;
      blocked = new Promise<void>(resolve => { unblock = resolve; });
      await new Promise<void>(resolve => { entered = resolve; });
      return () => unblock?.();
    } });
  } finally { unblock?.(); for (const service of services) service.dispose(); globalThis.fetch = originalFetch; }
}

test('history cursor pages equal timestamps without gaps and ignores newly inserted leading orders', async () => {
  await fixture(async ({ service, rows, queries }) => {
    rows.push(...[1, 2, 3, 4, 5].map(n => row(n)), row(10, 'delivered', timestamp, customerB), row(11, 'delivered', timestamp, customerA, businessB));
    const first = await service.getOrderHistory({ limit: 2 });
    assert.deepEqual(first.orders.map(o => o.id), [orderId(5), orderId(4)]);
    assert.deepEqual(first.nextCursor, { createdAtISO: timestamp, id: orderId(4) }, 'cursor preserves all six timestamp fraction digits');
    rows.push(row(6, 'placed', '2026-11-14T11:00:00.000000Z'));
    const second = await service.getOrderHistory({ limit: 2, cursor: first.nextCursor });
    const last = await service.getOrderHistory({ limit: 2, cursor: second.nextCursor });
    assert.deepEqual([...first.orders, ...second.orders, ...last.orders].map(o => o.id), [5, 4, 3, 2, 1].map(orderId));
    assert.equal(last.nextCursor, null);
    assert.equal(queries[0].searchParams.get('limit'), '3', 'one lookahead row determines the next page');
    assert.equal((await service.getOrderHistory()).orders[0].id, orderId(6), 'refresh sees newly placed orders');
  });
});

test('history returns bounded empty, exact-size and timestamp-crossing pages', async () => {
  await fixture(async ({ service, rows, queries }) => {
    assert.deepEqual(await service.getOrderHistory(), { orders: [], nextCursor: null });
    assert.equal(queries[0].searchParams.get('limit'), '21');
    rows.push(row(3), row(2, 'delivered', '2026-11-13T10:00:00.123456Z'));
    const first = await service.getOrderHistory({ limit: 1 });
    const last = await service.getOrderHistory({ limit: 1, cursor: first.nextCursor });
    assert.equal(first.orders[0].id, orderId(3)); assert.equal(last.orders[0].id, orderId(2));
    assert.equal(last.nextCursor, null);
    assert.equal((await service.getOrderHistory({ limit: 2 })).nextCursor, null);
    await service.getOrderHistory({ limit: 50 });
    assert.equal(queries.at(-1)?.searchParams.get('limit'), '51');
  });
});

test('active orders page independently of history and exclude terminal orders for both restaurants', async () => {
  await fixture(async ({ service, rows, create }) => {
    rows.push(row(1, 'preparing'), row(2, 'out_for_delivery'), row(3, 'accepted'), row(4, 'placed'), row(5), row(6, 'cancelled'), row(7, 'placed', timestamp, customerA, businessB));
    await service.getOrderHistory({ limit: 1 });
    const first = await service.getActiveOrders({ limit: 2 });
    const last = await service.getActiveOrders({ limit: 2, cursor: first.nextCursor });
    assert.deepEqual([...first.orders, ...last.orders].map(o => o.id), [4, 3, 2, 1].map(orderId));
    assert.equal(last.nextCursor, null);
    const otherRestaurant = create('customer', 'kokani-dine-inn');
    await otherRestaurant.auth.signIn('customer@example.test', 'synthetic-password');
    assert.deepEqual((await otherRestaurant.getActiveOrders()).orders.map(o => o.id), [orderId(7)]);
  });
});

test('direct customer lookup finds older orders and returns no data for another owner, restaurant or missing ID', async () => {
  await fixture(async ({ service, rows, queries }) => {
    rows.push(row(1, 'cancelled', '2026-10-01T10:00:00.000000Z'), row(2), row(3, 'placed', timestamp, customerB), row(4, 'placed', timestamp, customerA, businessB));
    assert.equal((await service.getOrderHistory({ limit: 1 })).orders[0].id, orderId(2));
    const old = await service.getCustomerOrder(orderId(1));
    assert.equal(old?.id, orderId(1)); assert.equal(old?.lines[0].name, 'Synthetic dish');
    for (const n of [3, 4, 100]) assert.equal(await service.getCustomerOrder(orderId(n)), null);
    assert.equal(queries.at(-1)?.searchParams.has('limit'), false, 'individual lookup does not depend on paging');
  });
});

test('malformed cursor, order ID and page limits fail before any order request', async () => {
  await fixture(async ({ service, queries }) => {
    const valid: OrderCursor = { createdAtISO: timestamp, id: orderId(1) };
    for (const limit of [0, -1, 51, 1.5, NaN, Infinity, null, '2']) {
      await assert.rejects(service.getOrderHistory({ limit: limit as number }), code('INVALID_ORDER_QUERY'));
    }
    for (const options of [null, [], 'page', 1]) await assert.rejects(service.getOrderHistory(options as OrderPageOptions), code('INVALID_ORDER_QUERY'));
    for (const cursor of [{ ...valid, id: 'x),customer_id.neq.x' }, { ...valid, createdAtISO: timestamp + ',id.gt.0' }, { ...valid, createdAtISO: '2026-02-30T10:00:00Z' }, { ...valid, createdAtISO: '2026-11-14' }, { ...valid, createdAtISO: '2026-11-14T25:00:00Z' }, { ...valid, createdAtISO: '2026-11-14T10:00:00.1234567Z' }, {}, 'cursor', false]) {
      await assert.rejects(service.getOrderHistory({ cursor: cursor as OrderCursor }), code('INVALID_ORDER_QUERY'));
      await assert.rejects(service.getActiveOrders({ cursor: cursor as OrderCursor }), code('INVALID_ORDER_QUERY'));
    }
    for (const id of ['', 'bad', 'x),customer_id.neq.x', null]) await assert.rejects(service.getCustomerOrder(id as string), code('INVALID_ORDER_QUERY'));
    assert.equal(queries.length, 0);
  });
});

test('customer APIs fail closed in guest, admin and demo contexts and propagate backend failures', async () => {
  await fixture(async ({ service, create, failOrders }) => {
    const guest = create(), admin = create('admin');
    for (const method of [() => guest.getOrderHistory(), () => guest.getActiveOrders(), () => guest.getCustomerOrder(orderId(1))]) await assert.rejects(method());
    for (const method of [() => admin.getOrderHistory(), () => admin.getActiveOrders(), () => admin.getCustomerOrder(orderId(1))]) await assert.rejects(method(), code('CUSTOMER_REQUIRED'));
    failOrders();
    await assert.rejects(service.getOrderHistory(), /Synthetic order load failure/);
    await assert.rejects(service.getCustomerOrder(orderId(1)), /Synthetic order load failure/);
  });
  const demo = createMarketServices({ businessSlug: 'ammu-sammu', audience: 'customer', config: {} });
  try {
    await assert.rejects(demo.getOrderHistory(), code('DEMO_MODE'));
    await assert.rejects(demo.getActiveOrders(), code('DEMO_MODE'));
    await assert.rejects(demo.getCustomerOrder(orderId(1)), code('DEMO_MODE'));
  } finally { demo.dispose(); }
});

test('in-flight customer reads reject after sign-out, account switches, or disposal', async () => {
  for (const action of ['signout', 'switch', 'dispose'] as const) {
    for (const kind of ['history', 'active', 'single'] as const) {
      await fixture(async ({ service, rows, hold }) => {
        rows.push(row(1, 'placed'));
        const waiting = hold('orders');
        const request = kind === 'history' ? service.getOrderHistory() : kind === 'active' ? service.getActiveOrders() : service.getCustomerOrder(orderId(1));
        const rejected = assert.rejects(request, code('SESSION_CHANGED'));
        const release = await waiting;
        if (action === 'signout') await service.auth.signOut();
        else if (action === 'switch') await service.auth.signIn('other@example.test', 'synthetic-password');
        else service.dispose();
        release(); await rejected;
      });
    }
  }
});

test('identity changes while resolving customer or business prevent the order read', async () => {
  for (const path of ['user', 'businesses'] as const) {
    await fixture(async ({ service, queries, hold }) => {
      const waiting = hold(path);
      const request = service.getOrderHistory();
      const rejected = assert.rejects(request, code('SESSION_CHANGED'));
      const release = await waiting;
      await service.auth.signOut(); release(); await rejected;
      assert.equal(queries.length, 0);
    });
  }
});
