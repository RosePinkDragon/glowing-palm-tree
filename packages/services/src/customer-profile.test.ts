import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMarketServices, ServiceError } from './index.ts';

const customerA = '20000000-0000-4000-8000-000000000001';
const customerB = '20000000-0000-4000-8000-000000000002';
const code = (expected: string) => (error: unknown) => error instanceof ServiceError && error.code === expected;
const stamp = '2026-11-26T10:00:00.123456+00:00';

interface Seen { method: string; url: URL; headers: Headers; body: unknown }
type Failure = { status: number; body: Record<string, unknown> };

/** Drive the real SDK against a deterministic HTTP fixture of the auth endpoints and the profiles table. */
async function fixture(run: (f: {
  service: ReturnType<typeof createMarketServices>; seen: Seen[]; names: Map<string, string>; create: (audience?: 'customer' | 'admin') => ReturnType<typeof createMarketServices>;
  hold: () => Promise<() => void>; failNext: (failure: Failure) => void; setCurrentUserLookup: (fn: () => Response) => void;
}) => Promise<void>) {
  const originalFetch = globalThis.fetch;
  const services: ReturnType<typeof createMarketServices>[] = [], seen: Seen[] = [], names = new Map<string, string>();
  let blocked: Promise<void> | undefined, unblock: (() => void) | undefined, entered: (() => void) | undefined, holdNext = false, failure: Failure | undefined, userLookup: (() => Response) | undefined;
  const token = (id: string) => `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: id, role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.signature`;
  const userFrom = (headers: HeadersInit | undefined) => {
    const claim = (new Headers(headers).get('authorization') ?? '').split('.')[1];
    return claim ? JSON.parse(Buffer.from(claim, 'base64url').toString()).sub as string : undefined;
  };
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input)), headers = new Headers(init?.headers);
    if (url.pathname.endsWith('/token')) {
      const id = JSON.parse(String(init?.body)).email === 'other@example.test' ? customerB : customerA;
      return Response.json({ access_token: token(id), refresh_token: 'synthetic-refresh', expires_in: 3600, token_type: 'bearer', user: { id, aud: 'authenticated' } });
    }
    if (url.pathname.endsWith('/logout')) return new Response(null, { status: 204 });
    if (url.pathname.endsWith('/user')) {
      if (userLookup) return userLookup();
      const id = userFrom(init?.headers);
      return id ? Response.json({ id, aud: 'authenticated' }) : Response.json({ message: 'Sign in required' }, { status: 401 });
    }
    if (url.pathname.endsWith('/profiles')) {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      seen.push({ method: init?.method ?? 'GET', url, headers, body });
      if (holdNext) { holdNext = false; entered?.(); await blocked; }
      if (failure) { const f = failure; failure = undefined; return Response.json(f.body, { status: f.status }); }
      const me = userFrom(init?.headers)!;
      if ((init?.method ?? 'GET') === 'GET') {
        assert.equal(url.searchParams.get('user_id'), `eq.${me}`, 'the read names only the verified user');
        const rows = names.has(me) ? [{ user_id: me, full_name: names.get(me), updated_at: stamp }] : [];
        return Response.json(headers.get('accept')?.includes('pgrst.object') ? (rows[0] ?? null) : rows);
      }
      assert.equal(init?.method, 'POST');
      assert.equal(url.searchParams.get('on_conflict'), 'user_id');
      assert.match(headers.get('prefer') ?? '', /resolution=merge-duplicates/);
      assert.deepEqual(Object.keys(body), ['full_name'], 'only the name is sent; the database pins user_id');
      names.set(me, body.full_name);
      const row = { user_id: me, full_name: body.full_name, updated_at: stamp };
      return Response.json(headers.get('accept')?.includes('pgrst.object') ? row : [row], { status: 201 });
    }
    throw new Error(`Unexpected synthetic request ${url.pathname}`);
  };
  const create = (audience: 'customer' | 'admin' = 'customer') => {
    const values = new Map<string, string>();
    const service = createMarketServices({ businessSlug: 'ammu-sammu', audience, config: { url: 'https://customer-profile.test', anonKey: 'sb_publishable_test' }, storage: {
      getItem: k => values.get(k) ?? null, setItem: (k, v) => { values.set(k, v); }, removeItem: k => { values.delete(k); },
    } });
    services.push(service); return service;
  };
  const service = create();
  try {
    await service.auth.signIn('customer@example.test', 'synthetic-password');
    await run({ service, seen, names, create, failNext: f => { failure = f; }, setCurrentUserLookup: fn => { userLookup = fn; }, hold: async () => {
      holdNext = true; blocked = new Promise<void>(resolve => { unblock = resolve; });
      return () => unblock?.();
    } });
  } finally { unblock?.(); for (const service of services) service.dispose(); globalThis.fetch = originalFetch; void entered; }
}

test('a new account has no profile; saving creates it and reading returns it', async () => {
  await fixture(async ({ service, seen, names }) => {
    assert.equal(await service.getProfile(), null);
    assert.equal(seen[0].method, 'GET');
    assert.equal(seen[0].url.searchParams.get('select'), 'user_id,full_name,updated_at');
    const saved = await service.saveProfile({ fullName: 'Neha Rao' });
    assert.deepEqual(saved, { fullName: 'Neha Rao', updatedAtISO: stamp });
    assert.equal(names.get(customerA), 'Neha Rao');
    assert.deepEqual(await service.getProfile(), saved);
    assert.equal(seen.filter(s => s.method === 'POST').length, 1);
  });
});

test('the save is an upsert of the caller\'s own row and never names a user', async () => {
  await fixture(async ({ service, seen }) => {
    await service.saveProfile({ fullName: 'First' });
    await service.saveProfile({ fullName: 'Second' });
    const writes = seen.filter(s => s.method === 'POST');
    assert.equal(writes.length, 2);
    for (const write of writes) {
      assert.equal(write.url.searchParams.get('on_conflict'), 'user_id');
      assert.equal(write.url.searchParams.has('user_id'), false);
      assert.deepEqual(Object.keys(write.body as object), ['full_name']);
    }
    assert.equal((await service.getProfile())?.fullName, 'Second');
  });
});

test('names are trimmed and 1 to 120 characters; invalid names make no request', async () => {
  await fixture(async ({ service, seen, names }) => {
    assert.equal((await service.saveProfile({ fullName: '  Neha Rao \n' })).fullName, 'Neha Rao');
    assert.equal((seen.at(-1)?.body as { full_name: string }).full_name, 'Neha Rao', 'the trimmed name is what is sent');
    assert.equal((await service.saveProfile({ fullName: 'N' })).fullName, 'N');
    assert.equal((await service.saveProfile({ fullName: 'N'.repeat(120) })).fullName.length, 120);
    assert.equal((await service.saveProfile({ fullName: ` ${'N'.repeat(120)} ` })).fullName.length, 120, 'the limit applies after trimming');
    const before = seen.length;
    for (const fullName of ['', '   ', '\t\n', 'N'.repeat(121), undefined, null, 7] as unknown[]) {
      await assert.rejects(service.saveProfile({ fullName: fullName as string }), code('PROFILE_INVALID_NAME'), JSON.stringify(fullName));
    }
    await assert.rejects(service.saveProfile(undefined as never), code('PROFILE_INVALID_NAME'));
    assert.equal(seen.length, before, 'nothing is sent for an invalid name');
    assert.equal(names.get(customerA)?.length, 120);
  });
});

test('error mappings: inactive session, refused name, and everything else', async () => {
  await fixture(async ({ service, failNext }) => {
    failNext({ status: 403, body: { code: '42501', message: 'invalid session', details: 'INVALID_SESSION' } });
    await assert.rejects(service.saveProfile({ fullName: 'Neha' }), code('SIGN_IN_REQUIRED'));
    failNext({ status: 403, body: { code: '42501', message: 'invalid session', details: 'INVALID_SESSION' } });
    await assert.rejects(service.getProfile(), code('SIGN_IN_REQUIRED'));
    failNext({ status: 400, body: { code: '23514', message: 'new row for relation "profiles" violates check constraint "profiles_full_name_trimmed_check"', details: 'secret detail' } });
    await assert.rejects(service.saveProfile({ fullName: 'Neha' }), (error: unknown) => error instanceof ServiceError && error.code === 'PROFILE_INVALID_NAME' && error.message === 'Enter a name from 1 to 120 characters.');
    for (const status of [500, 401, 403]) {
      failNext({ status, body: { code: status === 403 ? '42501' : 'XX000', message: 'internal table detail', details: 'something private' } });
      await assert.rejects(service.saveProfile({ fullName: 'Neha' }), (error: unknown) => error instanceof ServiceError && error.code === 'PROFILE_REQUEST_FAILED' && !/internal|private/.test(error.message), String(status));
    }
    failNext({ status: 500, body: { code: 'XX000', message: 'boom' } });
    await assert.rejects(service.getProfile(), code('PROFILE_REQUEST_FAILED'));
    assert.equal((await service.saveProfile({ fullName: 'Neha' })).fullName, 'Neha', 'the service recovers after a failure');
  });
});

test('a response for another account or with an invalid name is refused', async () => {
  await fixture(async ({ service, names }) => {
    names.set(customerA, ' padded ');
    await assert.rejects(service.getProfile(), code('INVALID_RESPONSE'));
    names.set(customerA, 'N'.repeat(121));
    await assert.rejects(service.getProfile(), code('INVALID_RESPONSE'));
  });
});

test('guest, admin and demo contexts fail closed', async () => {
  await fixture(async ({ create, seen }) => {
    const guest = create(), admin = create('admin');
    await assert.rejects(guest.getProfile(), code('SIGN_IN_REQUIRED'));
    await assert.rejects(guest.saveProfile({ fullName: 'Neha' }), code('SIGN_IN_REQUIRED'));
    await assert.rejects(admin.getProfile(), code('CUSTOMER_REQUIRED'));
    await assert.rejects(admin.saveProfile({ fullName: 'Neha' }), code('CUSTOMER_REQUIRED'));
    assert.equal(seen.length, 0, 'no profile request is made');
  });
  const demo = createMarketServices({ businessSlug: 'ammu-sammu', audience: 'customer', config: {} });
  try {
    await assert.rejects(demo.getProfile(), code('DEMO_MODE'));
    await assert.rejects(demo.saveProfile({ fullName: 'Neha' }), code('DEMO_MODE'));
  } finally { demo.dispose(); }
});

test('in-flight reads and saves reject after sign-out, an account switch or disposal', async () => {
  for (const action of ['signout', 'switch', 'dispose'] as const) {
    for (const kind of ['read', 'save'] as const) {
      await fixture(async ({ service, seen, names, hold }) => {
        names.set(customerA, 'Neha Rao');
        const release = await hold();
        const request = kind === 'read' ? service.getProfile() : service.saveProfile({ fullName: 'Late name' });
        const rejected = assert.rejects(request, code('SESSION_CHANGED'), `${kind} after ${action}`);
        // Wait until the profile request is in flight, then change identity before it is answered.
        for (let i = 0; i < 200 && !seen.length; i++) await new Promise(resolve => setTimeout(resolve, 5));
        assert.equal(seen.length, 1, 'the request was in flight');
        if (action === 'signout') await service.auth.signOut();
        else if (action === 'switch') await service.auth.signIn('other@example.test', 'synthetic-password');
        else service.dispose();
        release();
        await rejected;
      });
    }
  }
});

test('after an account switch the new account reads only its own profile', async () => {
  await fixture(async ({ service, names }) => {
    names.set(customerA, 'Account A'); names.set(customerB, 'Account B');
    assert.equal((await service.getProfile())?.fullName, 'Account A');
    await service.auth.signIn('other@example.test', 'synthetic-password');
    assert.equal((await service.getProfile())?.fullName, 'Account B');
    await service.auth.signOut();
    await assert.rejects(service.getProfile(), code('SIGN_IN_REQUIRED'));
  });
});

test('a user lookup that disagrees with the signed-in session is refused', async () => {
  await fixture(async ({ service, seen, setCurrentUserLookup }) => {
    // The identity lookup answers for a different user than the one signed in.
    setCurrentUserLookup(() => Response.json({ id: customerB, aud: 'authenticated' }));
    await service.auth.signOut(); await service.auth.signIn('customer@example.test', 'synthetic-password');
    await assert.rejects(service.getProfile(), code('SESSION_CHANGED'));
    assert.equal(seen.length, 0);
  });
});
