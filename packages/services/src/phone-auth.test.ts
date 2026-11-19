import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMarketServices, OtpError, ServiceError, type OtpErrorCode } from './index.ts';

const allowed = new Set(['WRONG_OR_EXPIRED_CODE', 'RESEND_COOLDOWN', 'NOT_ON_WHATSAPP', 'RATE_LIMITED', 'GENERIC']);

const url = 'https://example.test';
const config = { url, anonKey: 'sb_publishable_test' };
const businessId = '10000000-0000-4000-8000-000000000001';
const userId = '57000000-0000-4000-8000-000000000001';
const accessToken = `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: userId, role: 'authenticated', session_id: userId, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.${Buffer.from('signature').toString('base64url')}`;
const sessionBody = { access_token: accessToken, refresh_token: 'refresh', expires_in: 3600, token_type: 'bearer', user: { id: userId, aud: 'authenticated', phone: '919876543210' } };
type Seen = { path: string; method: string; body: any; headers: Headers };
const code = (expected: OtpErrorCode) => (error: unknown) => error instanceof OtpError && error.code === expected && error instanceof ServiceError && allowed.has(error.code);

async function withFetch(handler: (seen: Seen) => Response | Promise<Response>, run: (seen: Seen[]) => Promise<void>) {
  const original = globalThis.fetch, seen: Seen[] = [];
  globalThis.fetch = async (input, init) => {
    const u = new URL(String(input)); let body: unknown = null;
    if (typeof init?.body === 'string') { try { body = JSON.parse(init.body); } catch { body = init.body; } }
    const entry = { path: u.pathname, method: init?.method ?? 'GET', body, headers: new Headers(init?.headers) };
    seen.push(entry); return handler(entry);
  };
  try { await run(seen); } finally { globalThis.fetch = original; }
}
const make = (audience: 'customer' | 'admin') => createMarketServices({ businessSlug: 'ammu-sammu', audience, config });
const authError = (status: number, error_code: string | undefined, msg: string) => Response.json({ code: status, ...(error_code ? { error_code } : {}), msg }, { status });

test('customer code request asks Auth for a code for the normalised number with the CAPTCHA token', async () => {
  const service = make('customer');
  try {
    await withFetch(() => Response.json({ message_id: 'm1' }), async (seen) => {
      for (const input of ['9876543210', '+91 98765 43210', '09876543210', '919876543210']) await service.auth.requestCode(input, 'captcha-token');
      assert.equal(seen.length, 4);
      for (const request of seen) {
        assert.equal(request.path, '/auth/v1/otp'); assert.equal(request.method, 'POST');
        assert.equal(request.body.phone, '+919876543210'); assert.equal(request.body.create_user, true);
        assert.equal(request.body.gotrue_meta_security.captcha_token, 'captcha-token');
      }
    });
    await withFetch(() => Response.json({}), async (seen) => {
      for (const bad of ['', '12345', '5876543210', '+14155550123', 'abc']) await assert.rejects(service.auth.requestCode(bad, 't'), code('GENERIC'));
      assert.equal(seen.length, 0, 'an invalid number reached the network');
    });
  } finally { service.dispose(); }
});

test('customer code request errors map to exactly the five screen outcomes', async () => {
  const service = make('customer');
  const cases: [string, () => Response | Promise<Response>, OtpErrorCode][] = [
    ['hook: not on WhatsApp', () => authError(422, undefined, 'NOT_ON_WHATSAPP'), 'NOT_ON_WHATSAPP'],
    ['resend cooldown', () => authError(429, 'over_sms_send_rate_limit', 'For security purposes, you can only request this after 42 seconds.'), 'RESEND_COOLDOWN'],
    ['project sms limit', () => authError(429, 'over_sms_send_rate_limit', 'SMS rate limit exceeded'), 'RATE_LIMITED'],
    ['request limit', () => authError(429, 'over_request_rate_limit', 'Request rate limit reached'), 'RATE_LIMITED'],
    ['hook rate limit', () => authError(429, undefined, 'RATE_LIMITED'), 'RATE_LIMITED'],
    ['captcha', () => authError(400, 'captcha_failed', 'captcha protection: request disallowed'), 'GENERIC'],
    ['provider error', () => authError(502, undefined, 'whatsapp_provider_error'), 'GENERIC'],
    ['server error', () => authError(500, 'unexpected_failure', 'boom'), 'GENERIC'],
    ['network failure', () => { throw new TypeError('offline'); }, 'GENERIC'],
  ];
  try {
    for (const [name, reply, expected] of cases) {
      await withFetch(reply, async () => { await assert.rejects(service.auth.requestCode('9876543210', 't'), code(expected), name); });
    }
    await withFetch(() => authError(429, 'over_sms_send_rate_limit', 'For security purposes, you can only request this after 42 seconds.'), async () => {
      await assert.rejects(service.auth.requestCode('9876543210', 't'), (e: unknown) => e instanceof OtpError && e.code === 'RESEND_COOLDOWN' && (e.cause as { retryAfterSeconds?: unknown }).retryAfterSeconds === 42);
    });
    // Server wording is never shown.
    await withFetch(() => authError(422, undefined, 'NOT_ON_WHATSAPP'), async () => {
      await assert.rejects(service.auth.requestCode('9876543210', 't'), (e: unknown) => e instanceof Error && !/NOT_ON_WHATSAPP/.test(e.message) && /WhatsApp/.test(e.message));
    });
  } finally { service.dispose(); }
});

test('code verification sends the six digits as an sms token and maps failures', async () => {
  const service = make('customer');
  try {
    await withFetch(() => Response.json(sessionBody), async (seen) => {
      const result = await service.auth.verifyCode('98765 43210', ' 123456 ');
      assert.equal(result.session?.access_token, accessToken);
      assert.equal(seen[0].path, '/auth/v1/verify');
      assert.deepEqual({ phone: seen[0].body.phone, token: seen[0].body.token, type: seen[0].body.type }, { phone: '+919876543210', token: '123456', type: 'sms' });
    });
    const cases: [string, () => Response, OtpErrorCode][] = [
      ['expired', () => authError(403, 'otp_expired', 'Token has expired or is invalid'), 'WRONG_OR_EXPIRED_CODE'],
      ['wrong', () => authError(400, undefined, 'Token has expired or is invalid'), 'WRONG_OR_EXPIRED_CODE'],
      ['unknown user', () => authError(422, undefined, 'Token has expired or is invalid'), 'WRONG_OR_EXPIRED_CODE'],
      ['rate limit', () => authError(429, 'over_request_rate_limit', 'Request rate limit reached'), 'RATE_LIMITED'],
      ['server error', () => authError(500, undefined, 'boom'), 'GENERIC'],
    ];
    for (const [name, reply, expected] of cases) await withFetch(reply, async () => { await assert.rejects(service.auth.verifyCode('9876543210', '123456'), code(expected), name); });
    await withFetch(() => Response.json(sessionBody), async (seen) => {
      for (const bad of ['', '12345', '1234567', 'abcdef', '12 3456', null as unknown as string]) await assert.rejects(service.auth.verifyCode('9876543210', bad), code('WRONG_OR_EXPIRED_CODE'));
      await assert.rejects(service.auth.verifyCode('123', '123456'), code('GENERIC'));
      assert.equal(seen.length, 0, 'malformed input reached Auth');
    });
  } finally { service.dispose(); }
});

test('owner code request goes through the Edge Function only, and cannot report WhatsApp delivery', async () => {
  const service = make('admin');
  try {
    await withFetch(() => Response.json({ ok: true }), async (seen) => {
      await service.auth.requestOwnerCode('9876543210', 'captcha-token');
      assert.equal(seen.length, 1);
      assert.equal(seen[0].path, '/functions/v1/request-owner-code'); assert.equal(seen[0].method, 'POST');
      assert.deepEqual(seen[0].body, { phone: '+919876543210', slug: 'ammu-sammu', captchaToken: 'captcha-token' });
      assert.equal(seen[0].headers.get('apikey'), 'sb_publishable_test');
      assert.ok(!seen.some((request) => request.path.startsWith('/auth/')), 'owner request called Auth directly');
    });
    const cases: [string, () => Response, OtpErrorCode][] = [
      ['captcha', () => Response.json({ ok: false, error: 'captcha_failed' }, { status: 400 }), 'GENERIC'],
      ['bad number', () => Response.json({ ok: false, error: 'invalid_phone' }, { status: 400 }), 'GENERIC'],
      ['gateway limit', () => new Response('slow down', { status: 429 }), 'RATE_LIMITED'],
      ['server error', () => new Response('boom', { status: 500 }), 'GENERIC'],
      ['unexpected success body', () => Response.json({ sent: true }), 'GENERIC'],
      ['hook-style message', () => authError(422, undefined, 'NOT_ON_WHATSAPP'), 'GENERIC'],
      ['network failure', () => { throw new TypeError('offline'); }, 'GENERIC'],
    ];
    for (const [name, reply, expected] of cases) await withFetch(reply, async () => { await assert.rejects(service.auth.requestOwnerCode('9876543210', 't'), code(expected), name); });
    await withFetch(() => Response.json({ ok: true }), async (seen) => {
      await assert.rejects(service.auth.requestOwnerCode('12345', 't'), code('GENERIC'));
      assert.equal(seen.length, 0);
    });
  } finally { service.dispose(); }
});

test('each audience can only use its own request path', async () => {
  const customer = make('customer'), owner = make('admin');
  try {
    await withFetch(() => Response.json({}), async (seen) => {
      await assert.rejects(owner.auth.requestCode('9876543210', 't'), (e: unknown) => e instanceof ServiceError && e.code === 'CUSTOMER_REQUIRED');
      await assert.rejects(customer.auth.requestOwnerCode('9876543210', 't'), (e: unknown) => e instanceof ServiceError && e.code === 'ADMIN_REQUIRED');
      assert.equal(seen.length, 0);
    });
  } finally { customer.dispose(); owner.dispose(); }
});

test('owners app: a verified code only signs in an admin member of this restaurant; anyone else fails like a wrong code', async () => {
  for (const member of [true, false]) {
    const service = make('admin');
    try {
      await withFetch((request) => {
        if (request.path === '/auth/v1/verify') return Response.json(sessionBody);
        if (request.path === '/auth/v1/user') return Response.json({ id: userId, aud: 'authenticated', phone: '919876543210' });
        if (request.path === '/rest/v1/businesses') return Response.json({ id: businessId, slug: 'ammu-sammu', name: 'Ammu Sammu', delivery_fee_paise: 0, min_order_paise: 0, is_demo: false, ordering_enabled: true, accepting_orders: true });
        if (request.path === '/rest/v1/business_memberships') return Response.json(member ? [{ role: 'admin' }] : []);
        if (request.path === '/auth/v1/logout') return new Response(null, { status: 204 });
        return new Response('unexpected', { status: 500 });
      }, async (seen) => {
        if (member) {
          assert.equal((await service.auth.verifyCode('9876543210', '123456')).session?.access_token, accessToken);
          assert.ok(await service.auth.session(), 'owner session dropped');
        } else {
          await assert.rejects(service.auth.verifyCode('9876543210', '123456'), code('WRONG_OR_EXPIRED_CODE'));
          assert.ok(seen.some((request) => request.path === '/auth/v1/logout'), 'non-owner session kept');
          assert.equal(await service.auth.session(), null, 'non-owner session still stored');
        }
      });
    } finally { service.dispose(); }
  }
  // A membership check that cannot complete never leaves a session behind.
  const service = make('admin');
  try {
    await withFetch((request) => {
      if (request.path === '/auth/v1/verify') return Response.json(sessionBody);
      if (request.path === '/auth/v1/logout') return new Response(null, { status: 204 });
      return new Response('down', { status: 500 });
    }, async () => {
      await assert.rejects(service.auth.verifyCode('9876543210', '123456'), code('GENERIC'));
      assert.equal(await service.auth.session(), null);
    });
  } finally { service.dispose(); }
});

test('demo mode refuses every code operation without a request', async () => {
  const service = createMarketServices({ businessSlug: 'ammu-sammu', audience: 'customer', config: {} });
  const owner = createMarketServices({ businessSlug: 'ammu-sammu', audience: 'admin', config: {} });
  try {
    await withFetch(() => Response.json({}), async (seen) => {
      for (const run of [() => service.auth.requestCode('9876543210'), () => service.auth.verifyCode('9876543210', '123456'), () => owner.auth.requestOwnerCode('9876543210')]) {
        await assert.rejects(run(), (e: unknown) => e instanceof ServiceError && e.code === 'DEMO_MODE');
      }
      assert.equal(seen.length, 0);
    });
  } finally { service.dispose(); owner.dispose(); }
});

test('owners app: a non-owner\'s code never touches the real client\'s storage or auth events; an owner\'s session does arrive', async () => {
  for (const member of [false, true]) {
    const writes: string[] = [], store = new Map<string, string>();
    const storage = { getItem: (name: string) => store.get(name) ?? null, setItem: (name: string, value: string) => { writes.push(`set:${name}`); store.set(name, value); }, removeItem: (name: string) => { writes.push(`remove:${name}`); store.delete(name); } };
    const service = createMarketServices({ businessSlug: 'ammu-sammu', audience: 'admin', config, storage });
    const events: string[] = [];
    try {
      await withFetch((request) => {
        if (request.path === '/auth/v1/verify') return Response.json(sessionBody);
        if (request.path === '/auth/v1/user') return Response.json({ id: userId, aud: 'authenticated', phone: '919876543210' });
        if (request.path === '/rest/v1/businesses') return Response.json({ id: businessId, slug: 'ammu-sammu', name: 'Ammu Sammu', delivery_fee_paise: 0, min_order_paise: 0, is_demo: false, ordering_enabled: true, accepting_orders: true });
        if (request.path === '/rest/v1/business_memberships') {
          // The membership check carries the verified session's token, not the real client's.
          assert.equal(request.headers.get('authorization'), `Bearer ${accessToken}`);
          return Response.json(member ? [{ role: 'admin' }] : []);
        }
        if (request.path === '/auth/v1/logout') return new Response(null, { status: 204 });
        return new Response('unexpected', { status: 500 });
      }, async () => {
        const stop = service.auth.onChange((event) => { events.push(event); });
        await new Promise((resolve) => setTimeout(resolve, 20)); // let the initial-session event settle
        const settledEvents = events.length, settledWrites = writes.length;
        if (member) {
          assert.equal((await service.auth.verifyCode('9876543210', '123456')).session?.access_token, accessToken);
          assert.ok(events.slice(settledEvents).includes('SIGNED_IN'), 'owner sign-in event missing');
          assert.ok(writes.slice(settledWrites).some((write) => write.startsWith('set:')) && store.size > 0, 'owner session not stored');
        } else {
          await assert.rejects(service.auth.verifyCode('9876543210', '123456'), code('WRONG_OR_EXPIRED_CODE'));
          await new Promise((resolve) => setTimeout(resolve, 20));
          assert.deepEqual(events.slice(settledEvents), [], `real client saw auth events: ${events.slice(settledEvents)}`);
          assert.deepEqual(writes.slice(settledWrites), [], `real client storage written: ${writes.slice(settledWrites)}`);
          assert.equal(store.size, 0, 'non-owner session stored');
          assert.equal(await service.auth.session(), null);
        }
        stop();
      });
    } finally { service.dispose(); }
  }
});

test('owners app: the throwaway client is the only one that sees the code, then only an owner moves to the real client', async () => {
  const service = make('admin');
  try {
    await withFetch((request) => {
      if (request.path === '/auth/v1/verify') return Response.json(sessionBody);
      if (request.path === '/rest/v1/businesses') return Response.json({ id: businessId, slug: 'ammu-sammu', name: 'Ammu Sammu', delivery_fee_paise: 0, min_order_paise: 0, is_demo: false, ordering_enabled: true, accepting_orders: true });
      if (request.path === '/rest/v1/business_memberships') return Response.json([]);
      if (request.path === '/auth/v1/logout') return new Response(null, { status: 204 });
      return new Response('unexpected', { status: 500 });
    }, async (seen) => {
      await assert.rejects(service.auth.verifyCode('9876543210', '123456'), code('WRONG_OR_EXPIRED_CODE'));
      assert.equal(seen.filter((request) => request.path === '/auth/v1/verify').length, 1);
      assert.ok(!seen.some((request) => request.path === '/auth/v1/user' || request.path === '/auth/v1/token'), 'the real client was handed the non-owner session');
    });
  } finally { service.dispose(); }
});
