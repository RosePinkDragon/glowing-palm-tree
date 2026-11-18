import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMarketServices, ServiceError } from './index.ts';

const user = '52100000-0000-4000-8000-000000000001', sid = '52100000-0000-4000-9000-000000000001';
const ammu = '10000000-0000-4000-8000-000000000001', kokani = '10000000-0000-4000-8000-000000000002';
const gen = (n: number) => `52100000-0000-4000-a000-00000000000${n}`;
const jwt = (id = user) => `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: id, session_id: sid, role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.sig`;
const link = (business: string, slug: string, name: string, n: number, state = 'active') => ({ business_id: business, generation: gen(n), state, businesses: { slug, name } });

async function run(rows: unknown, work: (service: ReturnType<typeof createMarketServices>, urls: URL[]) => Promise<void>, options: { audience?: 'customer' | 'admin'; status?: number } = {}) {
  const original = globalThis.fetch, urls: URL[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input)), name = url.pathname.split('/').at(-1);
    if (name === 'token') return Response.json({ access_token: jwt(), refresh_token: 'r', expires_in: 3600, token_type: 'bearer', user: { id: user, aud: 'authenticated' } });
    if (name === 'customer_businesses') { urls.push(url); return Response.json(options.status ? { message: 'boom' } : rows, { status: options.status ?? 200 }); }
    throw new Error(`unexpected ${url.pathname}`);
  };
  const storage = new Map<string, string>();
  const service = createMarketServices({ audience: options.audience ?? 'customer', businessSlug: 'ammu-sammu', config: { url: 'https://list.test', anonKey: 'sb_publishable_test' }, storage: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => { storage.set(k, v); }, removeItem: k => { storage.delete(k); } } });
  try { await service.auth.signIn('c@example.test', 'synthetic-password'); await work(service, urls); } finally { service.dispose(); globalThis.fetch = original; }
}
const code = (value: string) => (error: unknown) => error instanceof ServiceError && error.code === value;

test('reads only the caller\'s own links with restaurant names and states', async () => {
  await run([link(ammu, 'ammu-sammu', 'Ammu Sammu', 1), link(kokani, 'kokani-dine-inn', 'Kokani Dine Inn', 2, 'left')], async (service, urls) => {
    assert.deepEqual(await service.getMyRestaurants(), [
      { businessId: ammu, businessSlug: 'ammu-sammu', businessName: 'Ammu Sammu', generation: gen(1), state: 'active' },
      { businessId: kokani, businessSlug: 'kokani-dine-inn', businessName: 'Kokani Dine Inn', generation: gen(2), state: 'left' },
    ]);
    assert.equal(urls[0].searchParams.get('customer_id'), `eq.${user}`);
  });
});

test('rejects malformed, duplicate, unknown-restaurant and non-array replies', async () => {
  const good = link(ammu, 'ammu-sammu', 'Ammu Sammu', 1);
  for (const rows of [{}, [{ ...good, state: 'deleted' }], [{ ...good, generation: 'x' }], [{ ...good, businesses: null }], [{ ...good, businesses: { slug: 'other', name: 'Other' } }], [{ ...good, businesses: { slug: 'ammu-sammu', name: ' ' } }], [good, good]]) {
    await run(rows, async service => { await assert.rejects(service.getMyRestaurants(), code('INVALID_RESPONSE')); });
  }
});

test('failures and the admin audience never leak raw backend text', async () => {
  await run(null, async service => { await assert.rejects(service.getMyRestaurants(), (e: unknown) => e instanceof ServiceError && e.code === 'RESTAURANTS_UNAVAILABLE' && !/boom/.test(e.message)); }, { status: 500 });
  await run([], async service => { await assert.rejects(service.getMyRestaurants(), code('CUSTOMER_REQUIRED')); }, { audience: 'admin' });
});
