import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMarketServices, ServiceError } from './index.ts';

const user = '35200000-0000-4000-8000-000000000001', sid = '35200000-0000-4000-9000-000000000001';
const business = '10000000-0000-4000-8000-000000000001', otherBusiness = '10000000-0000-4000-8000-000000000002';
const generation = '35200000-0000-4000-a000-000000000001';
const jwt = (id = user, session = sid) => `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: id, session_id: session, role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.sig`;
const requestId = 'b5210000-0000-4000-a000-000000000001';
const input = () => ({ requestId, generation });
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
  if (name === state.failAt) return Response.json({ message:'Synthetic backend failure' }, { status:503 });
  if (name === 'user') return Response.json({ id, aud: 'authenticated' });
  if (name === 'businesses') return Response.json({ id: state.businessId ?? (url.searchParams.get('slug') === 'eq.kokani-dine-inn' ? otherBusiness : business), slug: url.searchParams.get('slug')?.slice(3), name: 'Restaurant', delivery_fee_paise: 0, min_order_paise: 0, is_demo: false, ordering_enabled: true });
  assert.equal(name, 'leave_business');
  assert.equal(init?.method, 'POST');
  const body = JSON.parse(String(init?.body));
  state.calls.push({ headers, body });
  await state.onLeave?.();
  if (state.transport) throw new TypeError('Synthetic network error');
  if (state.error) return Response.json(state.error, { status: 400 });
  return Response.json(state.reply === undefined ? { customer_id: id, business_id: body.p_business_slug === 'kokani-dine-inn' ? otherBusiness : business, generation, request_id: requestId, state: 'left', started_at: '2026-11-17T16:00:00.123456+00:00', completed_at: '2026-11-17T16:00:00.123457+00:00' } : state.reply);
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
 failAt?: 'businesses' | 'user'; businessId?: string; reply?: unknown; error?: { code: string; message: string; details?: string }; transport?: boolean; onLeave?: () => Promise<void>;
}

test('leave binds receipt/request/generation to caller and business; repeats recover the same receipt', async () => {
 await fixture(async ({ service,state,create }) => {
  const result=await service.leaveBusiness(input());
  assert.equal(result.state,'left'); assert.equal(result.generation,generation); assert.equal(result.requestId,requestId);
  assert.deepEqual(result.localCleanup,{ businessSlug:'ammu-sammu',generation,requestId });
  assert.deepEqual(await service.leaveBusiness(input()),result);
  assert.deepEqual(await service.leaveBusiness({requestId:requestId.toUpperCase(),generation:generation.toUpperCase()}),result,'UUID casing is canonicalized before sending and comparing a committed receipt');
  assert.deepEqual(state.calls[0].body,{p_business_slug:'ammu-sammu',p_request_id:requestId,p_generation:generation});
  assert.equal(state.calls[0].headers.get('authorization'),`Bearer ${jwt()}`);
  const inB=create('customer','kokani-dine-inn'); await inB.auth.signIn('customer@example.test','synthetic-password');
  assert.equal((await inB.leaveBusiness(input())).businessId,otherBusiness);
 });
});
test('leave strictly rejects forged, partial and malformed confirmations', async () => {
 await fixture(async ({ service,state }) => {
  const valid={customer_id:user,business_id:business,generation,request_id:requestId,state:'left',started_at:'2026-11-17T16:00:00Z',completed_at:'2026-11-17T16:00:00.000001Z'};
  for(const reply of [null,[],{},true,{...valid,customer_id:sid},{...valid,business_id:otherBusiness},{...valid,request_id:sid},{...valid,generation:sid},{...valid,state:'active'},{...valid,started_at:'2026-02-30T16:00:00Z'},{...valid,completed_at:'2026-11-17T15:59:59Z'},{...valid,completed_at:null},{...valid,completed_at:'2026-11-17T24:00:00Z'}]) {
   state.reply=reply; await assert.rejects(service.leaveBusiness(input()),code('INVALID_RESPONSE'));
  }
 });
});
test('leave maps exact lifecycle errors and transport failure, without parsing messages', async () => {
 await fixture(async ({ service,state }) => {
  for (const [dbCode,details,expected] of [
   ['42501','','SIGN_IN_REQUIRED'],['22023','INVALID_BUSINESS','INVALID_BUSINESS'],['22023','INVALID_LEAVE_REQUEST','INVALID_LEAVE_REQUEST'],
   ...['ACTIVE_ORDERS','LAST_BUSINESS','STALE_RELATIONSHIP','LEAVE_REQUEST_CONFLICT','BUSINESS_LIFECYCLE_PENDING','ACCOUNT_LIFECYCLE_PENDING'].map(c=>['PT409',c,c]),
   ['PT409','UNKNOWN','BUSINESS_LEAVE_FAILED'],['XX000','LAST_BUSINESS','BUSINESS_LEAVE_FAILED']
  ]) { state.error={code:dbCode,details,message:'Opaque refusal'}; await assert.rejects(service.leaveBusiness(input()),code(expected)); }
  state.error=undefined;state.transport=true;
  await assert.rejects(service.leaveBusiness(input()),code('BUSINESS_LEAVE_FAILED'));
  state.transport=false; state.failAt='businesses';
  await assert.rejects(service.leaveBusiness(input()),code('BUSINESS_LEAVE_FAILED'));
  state.failAt=undefined;
  assert.equal((await service.leaveBusiness(input())).requestId,requestId,'lost response retries same request');
 });
});
test('leave validates IDs and rejects signed-out, wrong audience, demo and disposed contexts', async () => {
 await fixture(async ({ service,state,create }) => {
  for(const bad of [{requestId:'bad',generation},{requestId,generation:'bad'},null]) await assert.rejects(service.leaveBusiness(bad as never),code('INVALID_LEAVE_REQUEST'));
  assert.equal(state.calls.length,0);
  const demo=createMarketServices({audience:'customer',businessSlug:'ammu-sammu',config:{url:'',anonKey:''}});
  try { await assert.rejects(demo.leaveBusiness(input()),code('DEMO_MODE')); } finally {demo.dispose();}
  await assert.rejects(create('admin').leaveBusiness(input()),code('CUSTOMER_REQUIRED'));
  await service.auth.signOut(); await assert.rejects(service.leaveBusiness(input()),code('SIGN_IN_REQUIRED'));
  service.dispose();await assert.rejects(service.leaveBusiness(input()),code('DISPOSED'));
 });
});
test('leave rejects completion after account/session replacement, sign-out or disposal', async () => {
 for(const change of ['account','session','logout','dispose']) await fixture(async ({ service,state,login }) => {
  state.onLeave=async()=>{
   if(change==='account')await login('35200000-0000-4000-8000-000000000002');
   else if(change==='session')await login(user,'35200000-0000-4000-9000-000000000002');
   else if(change==='logout')await service.auth.signOut();
   else service.dispose();
  };
  await assert.rejects(service.leaveBusiness(input()),code('SESSION_CHANGED'));
 });
});
