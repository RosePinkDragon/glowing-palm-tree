import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMarketServices, ServiceError } from './index.ts';

const user = '35200000-0000-4000-8000-000000000001', sid = '35200000-0000-4000-9000-000000000001';
const business = '10000000-0000-4000-8000-000000000001', otherBusiness = '10000000-0000-4000-8000-000000000002';
const generation = '35200000-0000-4000-a000-000000000001';
const jwt = (id = user, session = sid) => `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: id, session_id: session, role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.sig`;
const code = (value: string) => (error: unknown) => error instanceof ServiceError && error.code === value;

type Service = ReturnType<typeof createMarketServices>;
async function fixture(run: (f: { service: Service; state: State; login: (id?: string, session?: string) => Promise<void>; create: (audience?: 'customer' | 'admin', slug?: 'ammu-sammu' | 'kokani-dine-inn') => Service }) => Promise<void>) {
 const original = globalThis.fetch, services: Service[] = [];
 const state: State = { id: user, sid, calls: [] };
 globalThis.fetch = async (input, init) => {
  const url = new URL(String(input)), name = url.pathname.split('/').at(-1);
  const headers = new Headers(init?.headers);
  const token = headers.get('authorization')?.slice(7) ?? '';
  const id = token.split('.')[1] ? JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).sub : undefined;
  if (name === 'token') return Response.json({ access_token: jwt(state.id, state.sid), refresh_token: 'synthetic-refresh', expires_in: 3600, token_type: 'bearer', user: { id: state.id, aud: 'authenticated' } });
  if (name === 'logout') return new Response(null, { status: 204 });
  if (name === 'user') return Response.json({ id, aud: 'authenticated' });
  if (name === 'businesses') return Response.json({ id: state.businessId ?? (url.searchParams.get('slug') === 'eq.kokani-dine-inn' ? otherBusiness : business), slug: url.searchParams.get('slug')?.slice(3), name: 'Restaurant', delivery_fee_paise: 0, min_order_paise: 0, is_demo: false, ordering_enabled: true });
  assert.ok(name === 'join_business' || name === 'place_order');
  assert.equal(init?.method, 'POST');
  const body = JSON.parse(String(init?.body));
  state.calls.push({ headers, body });
  await state.onJoin?.();
  if (state.transport) throw new TypeError('Synthetic network error');
  if (state.error) return Response.json(state.error, { status: 400 });
  return Response.json(state.reply === undefined ? { customer_id: id, business_id: body.p_business_slug === 'kokani-dine-inn' ? otherBusiness : business, generation, state: 'active', joined_at: '2026-11-17T16:00:00.123456+00:00' } : state.reply);
 };
 const create = (audience: 'customer' | 'admin' = 'customer', slug: 'ammu-sammu' | 'kokani-dine-inn' = 'ammu-sammu') => {
  const storage = new Map<string, string>();
  const service = createMarketServices({ audience, businessSlug: slug, config: { url: 'https://join.test', anonKey: 'sb_publishable_test' }, storage: { getItem: k => storage.get(k) ?? null, setItem: (k,v) => { storage.set(k,v); }, removeItem: k => { storage.delete(k); } } });
  services.push(service); return service;
 };
 const service = create();
 const login = async (id = user, session = sid) => { state.id = id; state.sid = session; await service.auth.signIn('customer@example.test', 'synthetic-password'); };
 try { await login(); await run({ service, state, login, create }); }
 finally { for (const service of services) service.dispose(); globalThis.fetch = original; }
}
interface State {
 id: string; sid: string; calls: { headers: Headers; body: Record<string, unknown> }[];
 businessId?: string; reply?: unknown; error?: { code: string; message: string; details?: string }; transport?: boolean; onJoin?: () => Promise<void>;
}

test('join pins customer identity and configured restaurant, preserving generation/timestamp on retry', async () => {
 await fixture(async ({service,state,create}) => {
  const result = await service.joinBusiness();
  assert.deepEqual(result, { customerId: user, businessId: business, generation, joinedAtISO: '2026-11-17T16:00:00.123456+00:00', state: 'active' });
  assert.deepEqual(await service.joinBusiness(), result);
  assert.deepEqual(state.calls[0].body, { p_business_slug: 'ammu-sammu' });
  assert.equal(state.calls[0].headers.get('authorization'), `Bearer ${jwt()}`);
  const inB = create('customer','kokani-dine-inn'); await inB.auth.signIn('customer@example.test','synthetic-password');
  assert.equal((await inB.joinBusiness()).businessId, otherBusiness);
 });
});

test('join rejects malformed, partial, cross-user and cross-business confirmations', async () => {
 await fixture(async ({service,state}) => {
  const valid = { customer_id:user,business_id:business,generation,state:'active',joined_at:'2026-11-17T16:00:00Z' };
  for (const reply of [null,[],true,{}, { ...valid, customer_id: sid }, { ...valid,business_id:otherBusiness },{...valid,generation:4},{...valid,generation:'bad'}, {...valid,state:'leave_pending'}, {...valid,joined_at:null},{...valid,joined_at:'yesterday'},{...valid,joined_at:'2026-99-99T16:00:00Z'},{...valid,joined_at:'2026-02-30T16:00:00Z'},{...valid,joined_at:'2026-11-17T24:00:00Z'}]) {
   state.reply = reply; await assert.rejects(service.joinBusiness(),code('INVALID_RESPONSE'));
  }
  state.businessId='malformed'; state.reply={...valid,business_id:'malformed'};
  await assert.rejects(service.joinBusiness(),code('INVALID_RESPONSE'));
 });
});

test('join maps exact lifecycle codes/details without guessing from message or status', async () => {
 await fixture(async ({service,state}) => {
  for (const [dbCode,details,expected] of [
   ['42501','','SIGN_IN_REQUIRED'],['22023','INVALID_BUSINESS','INVALID_BUSINESS'],
   ['PT409','BUSINESS_LIFECYCLE_PENDING','BUSINESS_LIFECYCLE_PENDING'],['PT409','ACCOUNT_LIFECYCLE_PENDING','ACCOUNT_LIFECYCLE_PENDING'],
   ['PT409','OTHER_CONFLICT','BUSINESS_JOIN_FAILED'],['XX000','BUSINESS_LIFECYCLE_PENDING','BUSINESS_JOIN_FAILED'],['22023','','BUSINESS_JOIN_FAILED'],
  ]) { state.error = { code:dbCode,details,message:'Synthetic opaque message' }; await assert.rejects(service.joinBusiness(),code(expected)); }
  state.error=undefined; state.transport=true;
  await assert.rejects(service.joinBusiness(),code('BUSINESS_JOIN_FAILED'));
 });
});

test('join rejects wrong audience, signed-out and disposed services', async () => {
 await fixture(async ({service,create}) => {
  await assert.rejects(create('admin').joinBusiness(),code('CUSTOMER_REQUIRED'));
  await service.auth.signOut(); await assert.rejects(service.joinBusiness(),code('SIGN_IN_REQUIRED'));
  service.dispose(); await assert.rejects(service.joinBusiness(),code('DISPOSED'));
 });
});

test('join never reports completion after account/session replacement, sign-out or disposal in flight', async () => {
 for (const change of ['account','session','logout','dispose']) await fixture(async ({service,state,login}) => {
  state.onJoin = async () => {
   if (change === 'account') await login('35200000-0000-4000-8000-000000000002');
   else if (change === 'session') await login(user,'35200000-0000-4000-9000-000000000002');
   else if (change === 'logout') await service.auth.signOut();
   else service.dispose();
  };
  await assert.rejects(service.joinBusiness(),code('SESSION_CHANGED'));
 });
});


test('checkout maps lifecycle refusals distinctly and never implicitly joins', async () => {
 await fixture(async ({service,state}) => {
  const input = { lines: [], delivery: { name: 'Customer', phone: '123' }, location: null,
   idempotencyKey: generation, savedAddress: { id: generation, version: 1 },
   pricing: { lines: [], delivery_fee_paise: 0, min_order_paise: 0, subtotal_paise: 0, total_paise: 0 } };
  for (const [dbCode,details,expected] of [
   ['PT403','BUSINESS_JOIN_REQUIRED','BUSINESS_JOIN_REQUIRED'],
   ['PT409','BUSINESS_LIFECYCLE_PENDING','BUSINESS_LIFECYCLE_PENDING'],
   ['PT409','ACCOUNT_LIFECYCLE_PENDING','ACCOUNT_LIFECYCLE_PENDING'],
   ['PT409','','NOT_ACCEPTING_ORDERS'],
  ]) {
   state.error = { code:dbCode,details,message:'Opaque refusal' };
   await assert.rejects(service.placeOrder(input),code(expected));
  }
  assert.equal(state.calls.length,4);
  assert.ok(state.calls.every(call => 'p_idempotency_key' in call.body), 'all requests are placement, never join');
 });
});
