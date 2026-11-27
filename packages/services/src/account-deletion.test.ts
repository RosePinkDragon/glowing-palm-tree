import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMarketServices, ServiceError } from './index.ts';

const customerA = '20000000-0000-4000-8000-000000000001';
const customerB = '20000000-0000-4000-8000-000000000002';
const stamp = '2026-11-26T10:00:00.123456+00:00';
const code = (expected: string) => (error: unknown) => error instanceof ServiceError && error.code === expected;

/** The real SDK against a deterministic HTTP fixture of the auth endpoints and the request_account_deletion RPC. */
async function fixture(run: (f: { service: ReturnType<typeof createMarketServices>; create: (audience?: 'customer' | 'admin') => ReturnType<typeof createMarketServices>;
  calls: { body: unknown; headers: Headers }[]; answer: (response: Response | (() => Response)) => void }) => Promise<void>) {
  const originalFetch = globalThis.fetch, calls: { body: unknown; headers: Headers }[] = [], services: ReturnType<typeof createMarketServices>[] = [];
  let next: (() => Response) | undefined;
  const token = (id: string) => `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: id, role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.signature`;
  const userFrom = (headers: HeadersInit | undefined) => {
    const claim = (new Headers(headers).get('authorization') ?? '').split('.')[1];
    return claim ? JSON.parse(Buffer.from(claim, 'base64url').toString()).sub as string : undefined;
  };
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/token')) { const id = customerA; return Response.json({ access_token: token(id), refresh_token: 'r', expires_in: 3600, token_type: 'bearer', user: { id, aud: 'authenticated' } }); }
    if (url.pathname.endsWith('/logout')) return new Response(null, { status: 204 });
    if (url.pathname.endsWith('/user')) { const id = userFrom(init?.headers); return id ? Response.json({ id, aud: 'authenticated' }) : Response.json({ message: 'Sign in required' }, { status: 401 }); }
    if (url.pathname.endsWith('/rpc/request_account_deletion')) {
      calls.push({ body: init?.body ? JSON.parse(String(init.body)) : undefined, headers: new Headers(init?.headers) });
      if (next) { const r = next; next = undefined; return r(); }
      return Response.json({ customer_id: userFrom(init?.headers), state: 'deletion_pending', requested_at: stamp });
    }
    throw new Error(`Unexpected synthetic request ${url.pathname}`);
  };
  const create = (audience: 'customer' | 'admin' = 'customer') => {
    const values = new Map<string, string>();
    const service = createMarketServices({ businessSlug: 'ammu-sammu', audience, config: { url: 'https://account-deletion.test', anonKey: 'sb_publishable_test' }, storage: {
      getItem: k => values.get(k) ?? null, setItem: (k, v) => { values.set(k, v); }, removeItem: k => { values.delete(k); } } });
    services.push(service); return service;
  };
  const service = create();
  try {
    await service.auth.signIn('customer@example.test', 'synthetic-password');
    await run({ service, create, calls, answer: r => { next = typeof r === 'function' ? r : () => r; } });
  } finally { for (const s of services) s.dispose(); globalThis.fetch = originalFetch; }
}

const failure = (status: number, body: Record<string, unknown>) => Response.json(body, { status });

test('deleting calls the RPC with no arguments and returns the server confirmation; repeating is the same', async () => {
  await fixture(async ({ service, calls }) => {
    const receipt = await service.requestAccountDeletion();
    assert.deepEqual(receipt, { customerId: customerA, state: 'deletion_pending', requestedAtISO: stamp });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body === undefined || Object.keys(calls[0].body as object).length === 0, true, 'no account id is sent; the database uses the session');
    assert.deepEqual(await service.requestAccountDeletion(), receipt, 'a retry returns the same confirmation');
  });
});

test('refusals map to their own codes and never echo server text', async () => {
  await fixture(async ({ service, answer }) => {
    answer(failure(409, { code: 'PT409', message: 'finish active orders', details: 'ACCOUNT_HAS_ACTIVE_ORDER' }));
    await assert.rejects(service.requestAccountDeletion(), code('ACCOUNT_HAS_ACTIVE_ORDER'));
    answer(failure(409, { code: 'PT409', message: 'add another owner first', details: 'ONLY_OWNER' }));
    await assert.rejects(service.requestAccountDeletion(), code('ONLY_OWNER'));
    answer(failure(403, { code: '42501', message: 'invalid session', details: 'INVALID_SESSION' }));
    await assert.rejects(service.requestAccountDeletion(), code('SIGN_IN_REQUIRED'));
    answer(failure(409, { code: 'PT409', message: 'account lifecycle pending', details: 'ACCOUNT_LIFECYCLE_PENDING' }));
    await assert.rejects(service.requestAccountDeletion(), code('ACCOUNT_LIFECYCLE_PENDING'));
    for (const body of [{ code: 'XX000', message: 'internal table detail', details: 'private' }, { code: 'PT409', message: 'x', details: 'SOMETHING_ELSE' }, { code: '42501', message: 'denied', details: null }]) {
      answer(failure(500, body));
      await assert.rejects(service.requestAccountDeletion(), (e: unknown) => e instanceof ServiceError && e.code === 'ACCOUNT_DELETION_FAILED' && !/internal|private|denied/.test(e.message));
    }
    assert.equal((await service.requestAccountDeletion()).state, 'deletion_pending', 'the service recovers after a failure');
  });
});

test('a confirmation for another account or in another shape is refused', async () => {
  await fixture(async ({ service, answer }) => {
    for (const body of [{ customer_id: customerB, state: 'deletion_pending', requested_at: stamp }, { customer_id: customerA, state: 'active', requested_at: stamp },
      { customer_id: customerA, state: 'deletion_pending', requested_at: 'not a time' }, { customer_id: customerA, state: 'deletion_pending' }, null]) {
      answer(Response.json(body));
      await assert.rejects(service.requestAccountDeletion(), code('INVALID_RESPONSE'), JSON.stringify(body));
    }
  });
});

test('guests and the owner app fail closed without calling the RPC', async () => {
  await fixture(async ({ create, calls }) => {
    await assert.rejects(create().requestAccountDeletion(), code('SIGN_IN_REQUIRED'));
    const admin = create('admin');
    await admin.auth.signIn('owner@example.test', 'synthetic-password');
    await assert.rejects(admin.requestAccountDeletion(), code('CUSTOMER_REQUIRED'));
    assert.equal(calls.length, 0);
  });
});

test('an order whose customer details were purged maps to a safe placeholder for owners', async () => {
  const { mapOrder } = await import('./index.ts');
  const purged = { id: '40000000-0000-4000-8000-000000000001', status: 'delivered' as const, version: 5, subtotal_paise: 100, delivery_fee_paise: 0, total_paise: 100,
    customer_name: null, customer_phone: null, delivery_address_line: null, latitude: null, longitude: null, created_at: stamp,
    address_label: null, address_house: null, address_street_area: null, address_location_source: null, saved_address_id: null, placed_from_distance_m: null, kitchen_distance_m: null,
    order_items: [{ diet: null, menu_item_id: 'm', name: 'Dish', quantity: 1, unit_price_paise: 100, line_total_paise: 100 }] };
  const order = mapOrder(purged, 'ammu-sammu');
  assert.deepEqual(order.delivery, { name: 'Deleted customer', phone: '', addressLine: 'Address removed' });
  assert.equal(order.location, undefined);
  assert.equal(order.address, undefined);
  assert.equal(order.totalPaise, 100);
  assert.equal(order.status, 'delivered');
});
