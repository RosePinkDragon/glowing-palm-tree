import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMarketServices, ServiceError, type NotificationPageOptions } from './index.ts';

const userA = '55000000-0000-4000-8000-000000000001', userB = '55000000-0000-4000-8000-000000000002';
const businessA = '10000000-0000-4000-8000-000000000001', businessB = '10000000-0000-4000-8000-000000000002';
const id = (n: number) => `55000000-0000-4000-a000-${String(n).padStart(12, '0')}`;
const timestamp = '2026-11-17T10:00:00.123456+00:00';
const row = (n: number, user = userA, business = businessA, created = timestamp): Record<string, unknown> => ({
  id: id(n), user_id: user, business_id: business, order_id: id(100 + n), event_status: 'placed',
  title: 'Order update', body: 'Your order was placed.', read_at: null, created_at: created,
});
type Service = ReturnType<typeof createMarketServices>;
const code = (expected: string) => (error: unknown) => error instanceof ServiceError && error.code === expected;
const names = ['list_customer_notifications', 'mark_customer_notification_read', 'mark_all_customer_notifications_read', 'customer_notification_unread_count'] as const;

/** Real installed SDK, synthetic HTTP only; no Supabase project or credentials. */
async function fixture(run: (f: {
  service: Service; rows: Record<string, unknown>[]; calls: { name: string; body: Record<string, unknown> }[];
  create: (audience?: 'customer' | 'admin', slug?: 'ammu-sammu' | 'kokani-dine-inn') => Service;
  responses: Map<string, unknown>; fail: (sqlstate: string) => void; transportFailure: () => void; hold: (name: string) => Promise<() => void>;
}) => Promise<void>) {
  const originalFetch = globalThis.fetch;
  const services: Service[] = [], rows: Record<string, unknown>[] = [], calls: { name: string; body: Record<string, unknown> }[] = [];
  const responses = new Map<string, unknown>();
  let failure: string | undefined, failTransport = false, heldName: string | undefined, blocked: Promise<void> | undefined, unblock: (() => void) | undefined, entered: (() => void) | undefined;
  const token = (user: string) => `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: user, role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.signature`;
  const userFrom = (headers: HeadersInit | undefined) => {
    const claim = (new Headers(headers).get('authorization') ?? '').split('.')[1];
    return claim ? JSON.parse(Buffer.from(claim, 'base64url').toString()).sub as string : undefined;
  };
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input)), name = url.pathname.split('/').at(-1)!;
    if (name === heldName) { heldName = undefined; entered?.(); await blocked; }
    if (name === 'token') {
      const user = JSON.parse(String(init?.body)).email === 'other@example.test' ? userB : userA;
      return Response.json({ access_token: token(user), refresh_token: 'synthetic-refresh', expires_in: 3600, token_type: 'bearer', user: { id: user, aud: 'authenticated' } });
    }
    if (name === 'logout') return new Response(null, { status: 204 });
    if (name === 'user') {
      const user = userFrom(init?.headers);
      return user ? Response.json({ id: user, aud: 'authenticated' }) : Response.json({ message: 'Sign in required' }, { status: 401 });
    }
    if (name === 'businesses') {
      const slug = url.searchParams.get('slug')?.slice(3);
      return Response.json({ id: slug === 'kokani-dine-inn' ? businessB : businessA, slug, name: 'Test business', delivery_fee_paise: 0, min_order_paise: 0, is_demo: false, ordering_enabled: true });
    }
    assert.ok(names.includes(name as typeof names[number]), `unexpected SDK request: ${name}`);
    assert.equal(init?.method, 'POST');
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ name, body });
    assert.deepEqual(Object.keys(body).sort(), name === names[0] ? ['p_before_created_at', 'p_before_id', 'p_business_slug', 'p_limit'] : name === names[1] ? ['p_business_slug', 'p_notification_id'] : ['p_business_slug']);
    const user = userFrom(init?.headers), business = body.p_business_slug === 'kokani-dine-inn' ? businessB : businessA;
    if (failTransport) throw new TypeError('Synthetic network failure');
    if (failure) return Response.json({ message: 'Synthetic backend failure', code: failure }, { status: 400 });
    if (responses.has(name)) return Response.json(responses.get(name));
    const visible = rows.filter(r => r.user_id === user && r.business_id === business);
    if (name === names[0]) {
      const cursor = body.p_before_created_at, beforeId = body.p_before_id;
      return Response.json(visible.filter(r => cursor === null || String(r.created_at) < String(cursor) || (r.created_at === cursor && String(r.id) < String(beforeId)))
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || String(b.id).localeCompare(String(a.id))).slice(0, Number(body.p_limit) + 1));
    }
    if (name === names[1]) {
      const found = visible.find(r => r.id === body.p_notification_id);
      if (found) found.read_at ??= timestamp;
      return Response.json(!!found);
    }
    const unread = visible.filter(r => r.read_at === null);
    if (name === names[2]) for (const r of unread) r.read_at = timestamp;
    return Response.json(unread.length);
  };
  const create = (audience: 'customer' | 'admin' = 'customer', slug: 'ammu-sammu' | 'kokani-dine-inn' = 'ammu-sammu') => {
    const values = new Map<string, string>();
    const service = createMarketServices({ businessSlug: slug, audience, config: { url: 'https://customer-feed.test', anonKey: 'sb_publishable_test' }, storage: {
      getItem: k => values.get(k) ?? null, setItem: (k, v) => { values.set(k, v); }, removeItem: k => { values.delete(k); },
    } });
    services.push(service); return service;
  };
  const service = create();
  try {
    await service.auth.signIn('customer@example.test', 'synthetic-password');
    await run({ service, rows, calls, create, responses, fail: sqlstate => { failure = sqlstate; }, transportFailure: () => { failTransport = true; }, hold: async name => {
      heldName = name; blocked = new Promise<void>(resolve => { unblock = resolve; });
      await new Promise<void>(resolve => { entered = resolve; });
      return () => unblock?.();
    } });
  } finally { unblock?.(); for (const service of services) service.dispose(); globalThis.fetch = originalFetch; }
}

test('feed pages with timestamp/ID cursor, lookahead and restaurant/customer isolation', async () => {
  await fixture(async ({ service, rows, calls, create }) => {
    rows.push(...[1, 2, 3, 4, 5].map(n => row(n)), row(10, userB), row(11, userA, businessB));
    const first = await service.listNotifications({ limit: 2 });
    assert.deepEqual(first.notifications.map(n => n.id), [id(5), id(4)]);
    assert.deepEqual(first.nextCursor, { id: id(4), createdAtISO: timestamp });
    rows.push(row(6, userA, businessA, '2026-11-17T11:00:00.123456+00:00'));
    const second = await service.listNotifications({ limit: 2, cursor: first.nextCursor });
    const third = await service.listNotifications({ limit: 2, cursor: second.nextCursor });
    assert.deepEqual([...first.notifications, ...second.notifications, ...third.notifications].map(n => n.id), [5, 4, 3, 2, 1].map(id));
    assert.equal(third.nextCursor, null);
    assert.deepEqual(calls[1].body, { p_business_slug: 'ammu-sammu', p_limit: 2, p_before_created_at: timestamp, p_before_id: id(4) });
    const other = create('customer', 'kokani-dine-inn');
    await other.auth.signIn('customer@example.test', 'synthetic-password');
    assert.deepEqual((await other.listNotifications()).notifications.map(n => n.id), [id(11)]);
    assert.equal(first.notifications[0].businessId, 'ammu-sammu');
    assert.deepEqual(Object.keys(first.notifications[0]).sort(), ['body', 'businessId', 'createdAtISO', 'eventStatus', 'id', 'orderId', 'readAtISO', 'title']);
  });
});

test('empty/exact-size pages, all event mappings, read-one, mark-all and unread count', async () => {
  await fixture(async ({ service, rows }) => {
    assert.deepEqual(await service.listNotifications(), { notifications: [], nextCursor: null });
    assert.equal(await service.getUnreadNotificationCount(), 0);
    for (const [n, status] of ['placed', 'accepted', 'preparing', 'out_for_delivery', 'delivered', 'cancelled'].entries()) rows.push({ ...row(n + 1), event_status: status });
    rows.push(row(20, userB), row(21, userA, businessB));
    assert.equal((await service.listNotifications({ limit: 6 })).nextCursor, null);
    assert.equal(await service.getUnreadNotificationCount(), 6);
    assert.equal(await service.markNotificationRead(id(1)), true);
    assert.equal(await service.markNotificationRead(id(1)), true);
    assert.equal(await service.markNotificationRead(id(20)), false);
    assert.equal(await service.markNotificationRead(id(21)), false);
    assert.equal(await service.markNotificationRead(id(99)), false);
    assert.equal(await service.getUnreadNotificationCount(), 5);
    assert.equal(await service.markAllNotificationsRead(), 5);
    assert.equal(await service.markAllNotificationsRead(), 0);
    assert.equal(await service.getUnreadNotificationCount(), 0);
    assert.equal(rows.at(-1)?.read_at, null);
    assert.equal(rows.at(-2)?.read_at, null);
    assert.equal((await service.listNotifications()).notifications[0].readAtISO, timestamp);
  });
});

test('invalid inputs fail before sending any RPC', async () => {
  await fixture(async ({ service, calls }) => {
    for (const options of [null, [], 1, { limit: 0 }, { limit: 101 }, { limit: 1.1 }, { limit: '2' }, { cursor: {} }, { cursor: { id: id(1), createdAtISO: '2026-02-30T10:00:00Z' } }, { cursor: { id: 'bad', createdAtISO: timestamp } }]) {
      await assert.rejects(service.listNotifications(options as NotificationPageOptions), code('INVALID_NOTIFICATION_QUERY'));
    }
    for (const invalid of ['', 'bad', 'x),user_id.neq.x', null, 1]) await assert.rejects(service.markNotificationRead(invalid as string), code('INVALID_NOTIFICATION_QUERY'));
    assert.equal(calls.length, 0);
  });
});

test('strict row mapping rejects invalid fields and cross-scope responses', async () => {
  await fixture(async ({ service, responses }) => {
    const badFields = { id: 'bad', user_id: userB, business_id: businessB, order_id: null, event_status: 'unknown', title: '', body: 4, read_at: 'bad', created_at: '2026-02-30T10:00:00Z' };
    for (const [field, value] of Object.entries(badFields)) {
      responses.set(names[0], [{ ...row(1), [field]: value }]);
      await assert.rejects(service.listNotifications(), code('INVALID_RESPONSE'), field);
    }
    for (const value of [null, {}, '[]', [null], [[]], [row(1), row(1)], [row(1), row(2)]]) {
      responses.set(names[0], value); await assert.rejects(service.listNotifications(), code('INVALID_RESPONSE'));
    }
    responses.set(names[0], [row(3), row(2), row(1)]);
    await assert.rejects(service.listNotifications({ limit: 1 }), code('INVALID_RESPONSE'));
    responses.set(names[0], [row(3)]);
    await assert.rejects(service.listNotifications({ cursor: { id: id(2), createdAtISO: timestamp } }), code('INVALID_RESPONSE'));
  });
});

test('mapping preserves microseconds and validates equivalent offset ordering', async () => {
  await fixture(async ({ service, responses }) => {
    responses.set(names[0], [row(1, userA, businessA, '2026-11-17T15:30:00.123456+05:30'), row(2, userA, businessA, '2026-11-17T10:00:00.123455Z')]);
    assert.equal((await service.listNotifications()).notifications[0].createdAtISO, '2026-11-17T15:30:00.123456+05:30');
    responses.set(names[0], [row(2, userA, businessA, '2026-11-17T10:00:00.123455Z'), row(1, userA, businessA, '2026-11-17T10:00:00.123456Z')]);
    await assert.rejects(service.listNotifications(), code('INVALID_RESPONSE'));
  });
});

test('boolean/count responses are strict and RPC failures have stable service codes', async () => {
  await fixture(async ({ service, responses, fail }) => {
    for (const value of [null, 1, 'true', {}]) {
      responses.set(names[1], value); await assert.rejects(service.markNotificationRead(id(1)), code('INVALID_RESPONSE'));
    }
    for (const name of [names[2], names[3]]) {
      for (const value of [null, -1, 1.1, '1', [], 2147483648]) {
        responses.set(name, value); await assert.rejects(name === names[2] ? service.markAllNotificationsRead() : service.getUnreadNotificationCount(), code('INVALID_RESPONSE'));
      }
    }
    for (const [sqlstate, expected] of [['22023', 'INVALID_NOTIFICATION_QUERY'], ['42501', 'NOTIFICATION_ACCESS_DENIED'], ['XX000', 'NOTIFICATION_REQUEST_FAILED']]) {
      fail(sqlstate);
      for (const operation of [() => service.listNotifications(), () => service.markNotificationRead(id(1)), () => service.markAllNotificationsRead(), () => service.getUnreadNotificationCount()]) await assert.rejects(operation(), code(expected));
    }
  });
});

test('guest/admin/demo/disposed callers fail before RPC', async () => {
  await fixture(async ({ calls, create }) => {
    const guest = create(), admin = create('admin');
    const demo = createMarketServices({ businessSlug: 'ammu-sammu', audience: 'customer' });
    for (const [service, expected] of [[guest, 'SIGN_IN_REQUIRED'], [admin, 'CUSTOMER_REQUIRED'], [demo, 'DEMO_MODE']] as const) {
      for (const operation of [() => service.listNotifications(), () => service.markNotificationRead(id(1)), () => service.markAllNotificationsRead(), () => service.getUnreadNotificationCount()]) await assert.rejects(operation(), code(expected));
    }
    guest.dispose(); await assert.rejects(guest.listNotifications(), code('DISPOSED'));
    demo.dispose(); assert.equal(calls.length, 0);
  });
});

test('transport failures use NOTIFICATION_REQUEST_FAILED for every method', async () => {
  await fixture(async ({ service, transportFailure }) => {
    transportFailure();
    for (const operation of [() => service.listNotifications(), () => service.markNotificationRead(id(1)), () => service.markAllNotificationsRead(), () => service.getUnreadNotificationCount()]) {
      await assert.rejects(operation(), code('NOTIFICATION_REQUEST_FAILED'));
    }
  });
});

test('all four methods reject results after sign-out, account switch or disposal', async () => {
  for (const change of ['sign-out', 'switch', 'dispose']) for (const name of names) {
    await fixture(async ({ service, hold }) => {
      const entered = hold(name);
      const operation = name === names[0] ? service.listNotifications() : name === names[1] ? service.markNotificationRead(id(1)) : name === names[2] ? service.markAllNotificationsRead() : service.getUnreadNotificationCount();
      const release = await entered;
      if (change === 'sign-out') await service.auth.signOut();
      else if (change === 'switch') await service.auth.signIn('other@example.test', 'synthetic-password');
      else service.dispose();
      release(); await assert.rejects(operation, code('SESSION_CHANGED'));
    });
  }
});
