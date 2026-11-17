import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMarketServices, ServiceError, validateOwnerDisplayName } from './index.ts';
import { withSupabaseTestEnvironment } from './test-environment.ts';

const owner = '55300000-0000-4000-8000-000000000001', other = '55300000-0000-4000-8000-000000000002';
const session = '55300000-0000-4000-9000-000000000001', replacement = '55300000-0000-4000-9000-000000000002';
const businessA = '10000000-0000-4000-8000-000000000001', businessB = '10000000-0000-4000-8000-000000000002';
const jwt = (user: string, sid: string, nonce = '') => `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: user, session_id: sid, nonce, role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.sig`;
const code = (expected: string) => (error: unknown) => error instanceof ServiceError && error.code === expected;
type Service = ReturnType<typeof createMarketServices>;
const member = (user = owner, business = businessA, displayName = 'Original Owner') => ({ business_id: business, user_id: user, role: 'admin', display_name: displayName });

/** Exercise the installed SDK, with synthetic HTTP and per-instance session storage. */
async function fixture(run: (f: {
 service: Service; state: State; create: (audience?: 'admin' | 'customer', slug?: 'ammu-sammu' | 'kokani-dine-inn') => Service;
 login: (service: Service, user?: string, sid?: string, nonce?: string) => Promise<void>; hold: (path: string) => Promise<() => void>;
}) => Promise<void>) {
 const originalFetch = globalThis.fetch, services: Service[] = [];
 const state: State = { members: new Map([[`${businessA}:${owner}`, member()], [`${businessA}:${other}`, member(other, businessA, 'Other Owner')], [`${businessB}:${owner}`, member(owner, businessB, 'Owner in B')]]),
  phone: '919876543210', calls: [], requests: [], loginUser: owner, loginSession: session, nonce: '' };
 let heldPath: string | undefined, blocked: Promise<void> | undefined, unblock: (() => void) | undefined, entered: (() => void) | undefined;
 globalThis.fetch = async (input, init) => {
  const url = new URL(String(input)), name = url.pathname.split('/').at(-1)!;
  const headers = new Headers(init?.headers), token = headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
  const claim = token.split('.')[1];
  const user = claim ? JSON.parse(Buffer.from(claim, 'base64url').toString()).sub as string : undefined;
  state.requests.push({ name, url, headers });
  if (name === heldPath) { heldPath = undefined; entered?.(); await blocked; }
  if (name === 'token') return Response.json({ access_token: jwt(state.loginUser, state.loginSession, state.nonce), refresh_token: 'synthetic-refresh', expires_in: 3600, token_type: 'bearer', user: { id: state.loginUser, aud: 'authenticated' } });
  if (name === 'logout') return new Response(null, { status: 204 });
  if (name === 'user' && state.transport === 'user') throw new TypeError('Synthetic auth transport failure');
  if (name === 'user' && state.transport === 'user401') return Response.json({ code: 401, msg: 'invalid JWT' }, { status: 401 });
  if (name === 'user' && state.transport === 'user503') return Response.json({ msg: 'unavailable' }, { status: 503 });
  if (name === 'user') return Response.json(state.userResponse === undefined ? { id: user, phone: state.phone, email: 'owner@example.test', aud: 'authenticated' } : state.userResponse);
  if (name === 'businesses') {
   const slug = url.searchParams.get('slug')?.slice(3);
   return Response.json({ id: slug === 'kokani-dine-inn' ? businessB : businessA, slug, name: 'Test business', delivery_fee_paise: 0, min_order_paise: 0, is_demo: false, ordering_enabled: true });
  }
  if (name === 'business_memberships') {
   if (state.transport === 'membership') throw new TypeError('Synthetic membership transport failure');
   if (state.membershipError) return Response.json({ code: 'TEST_ERROR', message: 'Synthetic membership failure' }, { status: 400 });
   assert.equal(url.searchParams.get('select'), 'business_id,user_id,role,display_name');
   assert.equal(url.searchParams.get('user_id'), `eq.${user}`, 'membership read uses verified caller and pinned token');
   assert.equal(url.searchParams.get('role'), 'eq.admin');
   const business = url.searchParams.get('business_id')?.slice(3);
   return Response.json(state.membershipResponse === undefined ? state.members.get(`${business}:${user}`) ?? null : state.membershipResponse);
  }
  assert.equal(name, 'set_owner_display_name');
  const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), ['p_business_slug', 'p_display_name']);
  assert.equal(init?.method, 'POST');
  state.calls.push({ headers, body });
  if (state.transport === 'save') throw new TypeError('Synthetic save transport failure');
  if (state.error) return Response.json(state.error, { status: 400 });
  const business = body.p_business_slug === 'kokani-dine-inn' ? businessB : businessA;
  const row = state.members.get(`${business}:${user}`);
  if (!row) return Response.json({ code: '42501', message: 'Owner access unavailable' }, { status: 403 });
  if (state.saveResponse !== undefined) return Response.json(state.saveResponse);
  row.display_name = String(body.p_display_name);
  return Response.json({ user_id: user, business_id: business, display_name: row.display_name });
 };
 const create = (audience: 'admin' | 'customer' = 'admin', slug: 'ammu-sammu' | 'kokani-dine-inn' = 'ammu-sammu') => {
  const values = new Map<string, string>();
  const service = createMarketServices({ audience, businessSlug: slug, config: { url: 'https://owner-name.test', anonKey: 'sb_publishable_test' }, storage: {
   getItem: k => values.get(k) ?? null, setItem: (k, v) => { values.set(k, v); }, removeItem: k => { values.delete(k); },
  } });
  services.push(service); return service;
 };
 const login = async (service: Service, user = owner, sid = session, nonce = '') => {
  state.loginUser = user; state.loginSession = sid; state.nonce = nonce;
  await service.auth.signIn('owner@example.test', 'synthetic-password');
 };
 const service = create();
 try {
  await login(service);
  await run({ service, state, create, login, hold: async path => {
   heldPath = path; blocked = new Promise<void>(resolve => { unblock = resolve; });
   await new Promise<void>(resolve => { entered = resolve; });
   return () => unblock?.();
  } });
 } finally { unblock?.(); for (const service of services) service.dispose(); globalThis.fetch = originalFetch; }
}
interface State {
 members: Map<string, ReturnType<typeof member>>; phone: unknown; loginUser: string; loginSession: string; nonce: string;
 userResponse?: unknown; membershipResponse?: unknown; saveResponse?: unknown; membershipError?: boolean;
 error?: { code: string; message: string; details?: string }; transport?: 'membership' | 'save' | 'user' | 'user401' | 'user503';
 calls: { headers: Headers; body: Record<string, unknown> }[]; requests: { name: string; url: URL; headers: Headers }[];
}

test('owner-name validation mirrors SQL, including code points and permitted Indic characters', () => {
 for (const value of ['A', 'a'.repeat(60), 'सुरेश', 'र्‍य', 'A\u200cB', 'e\u0301', '😀'.repeat(60), '\u1680Name\u1680']) assert.equal(validateOwnerDisplayName(value), value);
 for (const value of [null, undefined, 4, {}, [], '', ' ', ' padded', 'padded ', 'a'.repeat(61), '😀'.repeat(61), '\ud800', '\udfff']) assert.throws(() => validateOwnerDisplayName(value), code('INVALID_OWNER_NAME'));
 for (const char of ['\0', '\t', '\n', '\r', '\u0001', '\u007f', '\u0085', '\u009f', '\u00a0', '\u00ad', '\u2000', '\u200b', '\u200e', '\u200f', '\u2028', '\u202e', '\u205f', '\u2060', '\u2066', '\u2069', '\u3000', '\ufeff']) assert.throws(() => validateOwnerDisplayName(`A${char}B`), code('INVALID_OWNER_NAME'));
});

test('read returns current restaurant name plus verified Auth phone; setter changes only own scoped name', async () => {
 await fixture(async ({ service, state, create, login }) => {
  assert.deepEqual(await service.getOwnerProfile(), { displayName: 'Original Owner', phone: '919876543210' });
  const beforeOther = { ...state.members.get(`${businessA}:${other}`)! }, beforeBusiness = { ...state.members.get(`${businessB}:${owner}`)! };
  assert.equal(await service.setOwnerDisplayName('सुरेश'), 'सुरेश');
  assert.deepEqual(state.calls[0].body, { p_business_slug: 'ammu-sammu', p_display_name: 'सुरेश' });
  assert.equal(state.calls[0].headers.get('authorization'), `Bearer ${jwt(owner, session)}`);
  assert.deepEqual(state.members.get(`${businessA}:${other}`), beforeOther);
  assert.deepEqual(state.members.get(`${businessB}:${owner}`), beforeBusiness);
  assert.deepEqual(await service.getOwnerProfile(), { displayName: 'सुरेश', phone: '919876543210' });
  const inB = create('admin', 'kokani-dine-inn'); await login(inB);
  assert.deepEqual(await inB.getOwnerProfile(), { displayName: 'Owner in B', phone: '919876543210' });
  assert.equal(await inB.setOwnerDisplayName('New B'), 'New B');
  assert.equal(state.members.get(`${businessA}:${owner}`)?.display_name, 'सुरेश');
  assert.ok(state.requests.every(r => ['token', 'user', 'businesses', 'business_memberships', 'set_owner_display_name'].includes(r.name)), 'no Auth or phone updates');
 });
});

test('unavailable phone remains null, never substituted; malformed phones fail', async () => {
 await fixture(async ({ service, state }) => {
  for (const value of [undefined, null, '']) { state.phone = value; assert.equal((await service.getOwnerProfile()).phone, null); }
  state.phone = '+919876543210'; assert.equal((await service.getOwnerProfile()).phone, '+919876543210');
  for (const value of [4, {}, [], 'not a phone', ' 919876543210', '+', '0', '9'.repeat(16)]) {
   state.phone = value; await assert.rejects(service.getOwnerProfile(), code('INVALID_RESPONSE'));
  }
 });
});

for (const environment of ['unset', 'configured'] as const) test(`invalid names fail before network; guest/customer/demo/disposed/non-member calls fail closed (${environment} env)`, async () => {
 await withSupabaseTestEnvironment(environment, () => fixture(async ({ service, state, create }) => {
  const before = state.requests.length;
  for (const value of [null, {}, '', ' padded', 'a'.repeat(61)]) await assert.rejects(service.setOwnerDisplayName(value as string), code('INVALID_OWNER_NAME'));
  assert.equal(state.requests.length, before);
  const guest = create(), customer = create('customer'), demo = createMarketServices({ businessSlug: 'ammu-sammu', audience: 'admin', config: {} });
  for (const [instance, expected] of [[guest, 'SIGN_IN_REQUIRED'], [customer, 'ADMIN_REQUIRED'], [demo, 'DEMO_MODE']] as const) {
   await assert.rejects(instance.getOwnerProfile(), code(expected)); await assert.rejects(instance.setOwnerDisplayName('Name'), code(expected));
  }
  guest.dispose(); await assert.rejects(guest.getOwnerProfile(), code('DISPOSED')); await assert.rejects(guest.setOwnerDisplayName('Name'), code('DISPOSED')); demo.dispose();
  state.membershipResponse = null;
  await assert.rejects(service.getOwnerProfile(), code('ADMIN_REQUIRED')); await assert.rejects(service.setOwnerDisplayName('Name'), code('ADMIN_REQUIRED'));
  assert.equal(state.calls.length, 0);
 }));
});

test('strict membership and account mapping rejects malformed or cross-scope responses', async () => {
 await fixture(async ({ service, state }) => {
  for (const response of [{}, 4, { ...member(), user_id: other }, { ...member(), business_id: businessB }, { ...member(), role: 'customer' }, { ...member(), display_name: null }, { ...member(), display_name: ' padded' }]) {
   state.membershipResponse = response;
   await assert.rejects(service.getOwnerProfile(), code('INVALID_RESPONSE'));
   await assert.rejects(service.setOwnerDisplayName('Name'), code('INVALID_RESPONSE'));
  }
  state.membershipResponse = undefined; state.userResponse = { id: other, phone: '919876543210' };
  await assert.rejects(service.getOwnerProfile(), code('INVALID_RESPONSE'));
  await assert.rejects(service.setOwnerDisplayName('Name'), code('INVALID_RESPONSE'));
  assert.equal(state.calls.length, 0);
 });
});

test('save validates confirmation and uses explicit validation/access/transport errors', async () => {
 await fixture(async ({ service, state }) => {
  const valid = { user_id: owner, business_id: businessA, display_name: 'Name' };
  for (const response of [null, [], {}, 'Name', { ...valid, user_id: other }, { ...valid, business_id: businessB }, { ...valid, display_name: 'Other' }, { ...valid, display_name: '' }]) {
   state.saveResponse = response; await assert.rejects(service.setOwnerDisplayName('Name'), code('INVALID_RESPONSE'));
  }
  state.saveResponse = undefined;
  for (const [sqlstate, expected] of [['22023', 'INVALID_OWNER_NAME'], ['42501', 'ADMIN_REQUIRED'], ['XX000', 'OWNER_NAME_SAVE_FAILED']]) {
   state.error = { code: sqlstate, message: 'Synthetic failure', details: 'displayName' };
   await assert.rejects(service.setOwnerDisplayName('Name'), code(expected));
  }
  state.error = undefined; state.transport = 'save';
  await assert.rejects(service.setOwnerDisplayName('Name'), code('OWNER_NAME_SAVE_FAILED'));
  state.transport = 'membership';
  await assert.rejects(service.getOwnerProfile(), code('OWNER_PROFILE_REQUEST_FAILED'));
  await assert.rejects(service.setOwnerDisplayName('Name'), code('OWNER_PROFILE_REQUEST_FAILED'));
 });
});

test('read/save fence account changes, replacement sessions and disposal at every pre-RPC hop', async () => {
 for (const method of ['read', 'save']) for (const path of ['user', 'businesses', 'business_memberships']) for (const change of ['sign-out', 'other-owner', 'new-session', 'dispose']) {
  await fixture(async ({ service, state, hold, login }) => {
   const entered = hold(path);
   const operation = method === 'read' ? service.getOwnerProfile() : service.setOwnerDisplayName('Name');
   const release = await entered;
   if (change === 'sign-out') await service.auth.signOut();
   else if (change === 'other-owner') await login(service, other, replacement);
   else if (change === 'new-session') await login(service, owner, replacement);
   else service.dispose();
   release(); await assert.rejects(operation, code('SESSION_CHANGED'));
   assert.equal(state.calls.length, 0, `${method}/${path}/${change} cannot send a write`);
  });
 }
});

test('held RPC retains initiating token and never reports success to a replacement identity/session', async () => {
 for (const change of ['sign-out', 'other-owner', 'new-session', 'dispose']) await fixture(async ({ service, state, hold, login }) => {
  const entered = hold('set_owner_display_name'), operation = service.setOwnerDisplayName('Name');
  const release = await entered;
  if (change === 'sign-out') await service.auth.signOut();
  else if (change === 'other-owner') await login(service, other, replacement);
  else if (change === 'new-session') await login(service, owner, replacement);
  else service.dispose();
  release(); await assert.rejects(operation, code('SESSION_CHANGED'));
  assert.equal(state.calls[0].headers.get('authorization'), `Bearer ${jwt(owner, session)}`);
  assert.equal(state.members.get(`${businessA}:${other}`)?.display_name, 'Other Owner');
 });
});

test('matching-session token refresh remains valid and pins the refreshed token on save', async () => {
 await fixture(async ({ service, state, hold, login }) => {
  const entered = hold('business_memberships'), operation = service.setOwnerDisplayName('Refreshed Owner');
  const release = await entered;
  await login(service, owner, session, 'refresh'); release();
  assert.equal(await operation, 'Refreshed Owner');
  assert.equal(state.calls[0].headers.get('authorization'), `Bearer ${jwt(owner, session, 'refresh')}`);
 });
});

test('an unreachable or failing Auth check is a retryable error; only a real 4xx rejection is a denial', async () => {
 await fixture(async ({ service, state }) => {
  for (const [mode, expected] of [['user', 'OWNER_PROFILE_REQUEST_FAILED'], ['user503', 'OWNER_PROFILE_REQUEST_FAILED'], ['user401', 'ADMIN_REQUIRED']] as const) {
   state.transport = mode;
   await assert.rejects(service.getOwnerProfile(), code(expected), `read ${mode}`);
   await assert.rejects(service.setOwnerDisplayName('Name'), code(expected), `save ${mode}`);
  }
  assert.equal(state.calls.length, 0);
 });
});
