import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMarketServices, mapOrder } from './index.ts';

const row = {
  id: '49800000-0000-4000-8000-000000000001', status: 'accepted' as const, version: 2,
  subtotal_paise: 100, delivery_fee_paise: 0, total_paise: 100,
  customer_name: 'Customer', customer_phone: '0', delivery_address_line: 'Test',
  created_at: '2026-11-15T10:00:00Z', order_items: [],
  order_status_history: [
    { status: 'accepted' as const, created_at: '2026-11-15T10:01:00Z', order_history_actors: { actor_name: 'Asha' } },
    { status: 'placed' as const, created_at: '2026-11-15T10:00:00Z', order_history_actors: null },
  ],
};

test('owner snapshots map only into owner history; customer mapping strips unexpected actor fields', () => {
  assert.deepEqual(mapOrder(row, 'ammu-sammu', 'admin').history, [
    { status: 'placed', createdAtISO: '2026-11-15T10:00:00Z' },
    { status: 'accepted', createdAtISO: '2026-11-15T10:01:00Z', actorName: 'Asha' },
  ]);
  assert.deepEqual(mapOrder(row, 'ammu-sammu').history, [
    { status: 'placed', createdAtISO: '2026-11-15T10:00:00Z' },
    { status: 'accepted', createdAtISO: '2026-11-15T10:01:00Z' },
  ]);
});

test('installed SDK requests owner names only for owner services, with safe explicit history projections', async () => {
  const originalFetch = globalThis.fetch;
  const queries: URL[] = [];
  const token = `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: 'customer', role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.signature`;
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/token')) return Response.json({ access_token: token, refresh_token: 'fixture', expires_in: 3600, token_type: 'bearer', user: { id: 'customer', aud: 'authenticated' } });
    if (url.pathname.endsWith('/businesses')) return Response.json({ id: 'business', name: 'Restaurant' });
    if (url.pathname.endsWith('/user')) return Response.json({ id: 'customer', aud: 'authenticated' });
    if (url.pathname.endsWith('/orders')) { queries.push(url); return Response.json([row]); }
    throw new Error(`Unexpected fixture request: ${url.pathname}`);
  };
  const create = (audience: 'admin' | 'customer') => createMarketServices({
    businessSlug: 'ammu-sammu', audience,
    config: { url: 'https://owner-history.test', anonKey: 'sb_publishable_fixture' },
  });
  const admin = create('admin'), customer = create('customer');
  try {
    await customer.auth.signIn('customer@example.test', 'fixture');
    assert.equal((await admin.getOrders())[0].history?.[1].actorName, 'Asha');
    assert.equal((await customer.getOrders())[0].history?.[1].actorName, undefined);
    assert.equal(queries[0].searchParams.get('select'), '*,order_items(*),order_status_history(status,created_at,order_history_actors(actor_name))');
    assert.equal(queries[1].searchParams.get('select'), '*,order_items(*),order_status_history(status,created_at)');
    assert.equal(queries[1].searchParams.get('customer_id'), 'eq.customer');
  } finally { admin.dispose(); customer.dispose(); globalThis.fetch = originalFetch; }
});
