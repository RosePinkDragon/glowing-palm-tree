import { ERROR_MESSAGES, handleHook, msg91Client, verifySignature, type Msg91Config, type SendOutcome } from './hook.ts';

function assert(value: unknown, reason: string): asserts value { if (!value) throw new Error(reason); }
const encoder = new TextEncoder();
const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
// A test-only key, in the form Supabase shows it.
const keyBytes = Uint8Array.from({ length: 24 }, (_, i) => i * 7 + 3);
const secret = `v1,whsec_${toBase64(keyBytes)}`;
const NOW = 1_800_000_000;
const CODE = '482916';
const body = JSON.stringify({ metadata: { name: 'send-sms' }, user: { id: 'u', phone: '919876543210' }, sms: { otp: CODE, phone: '919876543210' } });

async function sign(payload: string, id = 'msg_1', timestamp = NOW, key = keyBytes) {
  const hmac = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', hmac, encoder.encode(`${id}.${timestamp}.${payload}`)));
  return { 'webhook-id': id, 'webhook-timestamp': String(timestamp), 'webhook-signature': `v1,${toBase64(signature)}` };
}
const post = (payload: string, headers: Record<string, string>) => new Request('https://example.test/functions/v1/send-sms-hook', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: payload });
function deps(outcome: SendOutcome | Error = 'sent') {
  const sends: [string, string][] = [];
  return { sends, deps: { secret, now: () => NOW * 1000, send: async (to: string, code: string) => { sends.push([to, code]); if (outcome instanceof Error) throw outcome; return outcome; } } };
}
async function capture<T>(run: () => Promise<T>): Promise<{ result: T; logs: string }> {
  const lines: string[] = []; const original = [console.error, console.log, console.warn, console.info];
  console.error = console.log = console.warn = console.info = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try { return { result: await run(), logs: lines.join('\n') }; } finally { [console.error, console.log, console.warn, console.info] = original; }
}

Deno.test('a correctly signed request sends the template once and answers 200 with JSON', async () => {
  const { sends, deps: d } = deps();
  const response = await handleHook(post(body, await sign(body)), d);
  assert(response.status === 200 && response.headers.get('content-type') === 'application/json', 'success must be 200 application/json');
  assert(JSON.stringify(await response.json()) === '{}', 'success body');
  assert(sends.length === 1 && sends[0][0] === '919876543210' && sends[0][1] === CODE, 'wrong send');
});

Deno.test('bad, missing, stale, replayed-body and wrong-key signatures are rejected before any send', async () => {
  const good = await sign(body);
  const wrongKey = await sign(body, 'msg_1', NOW, Uint8Array.from({ length: 24 }, (_, i) => i));
  const cases: [string, string, Record<string, string>][] = [
    ['no headers', body, {}],
    ['wrong key', body, wrongKey],
    ['tampered body', body.replace(CODE, '000000'), good],
    ['tampered id', body, { ...good, 'webhook-id': 'msg_2' }],
    ['tampered timestamp', body, { ...good, 'webhook-timestamp': String(NOW + 1) }],
    ['stale timestamp', body, await sign(body, 'msg_1', NOW - 301)],
    ['future timestamp', body, await sign(body, 'msg_1', NOW + 301)],
    ['non-numeric timestamp', body, { ...good, 'webhook-timestamp': 'abc' }],
    ['malformed signature', body, { ...good, 'webhook-signature': 'v1,%%%' }],
    ['unknown version', body, { ...good, 'webhook-signature': good['webhook-signature'].replace('v1,', 'v2,') }],
    ['empty signature', body, { ...good, 'webhook-signature': '' }],
  ];
  for (const [name, payload, headers] of cases) {
    const { sends, deps: d } = deps();
    const response = await handleHook(post(payload, headers), d);
    assert(response.status === 401 && sends.length === 0, `${name}: accepted or sent`);
  }
  const { sends, deps: d } = deps();
  assert((await handleHook(post(body, good), { ...d, secret: '' })).status === 401 && sends.length === 0, 'empty secret accepted');
  assert((await handleHook(new Request('https://example.test/', { method: 'GET' }), d)).status === 405, 'GET accepted');
});

Deno.test('a signature list may carry a rotated key, and the right one is found', async () => {
  const old = await sign(body, 'msg_1', NOW, Uint8Array.from({ length: 24 }, (_, i) => 200 - i));
  const current = await sign(body);
  const headers = { ...current, 'webhook-signature': `${old['webhook-signature']} ${current['webhook-signature']}` };
  assert(await verifySignature(secret, new Headers(headers), body, NOW), 'second signature not tried');
});

Deno.test('the secret may be given with or without the v1, prefix', async () => {
  const headers = new Headers(await sign(body));
  assert(await verifySignature(secret.replace('v1,', ''), headers, body, NOW), 'whsec_ form rejected');
  assert(!await verifySignature('v1,whsec_', headers, body, NOW) && !await verifySignature('v1,whsec_!!!', headers, body, NOW), 'broken secret accepted');
});

Deno.test('provider outcomes map to the error shape Auth passes to the client', async () => {
  const expected: [SendOutcome, number, string][] = [
    ['not_on_whatsapp', 422, 'NOT_ON_WHATSAPP'], ['rate_limited', 429, 'RATE_LIMITED'], ['provider_error', 502, 'GENERIC'],
  ];
  for (const [outcome, httpCode, message] of expected) {
    const { deps: d } = deps(outcome);
    const response = await handleHook(post(body, await sign(body)), d);
    // Auth only reads an error from a 200 JSON response; any other status becomes a generic 500.
    assert(response.status === 200 && response.headers.get('content-type') === 'application/json', `${outcome}: not a 200 JSON response`);
    assert(JSON.stringify(await response.json()) === JSON.stringify({ error: { http_code: httpCode, message } }), `${outcome}: wrong error body`);
  }
  assert(ERROR_MESSAGES.not_on_whatsapp.message === 'NOT_ON_WHATSAPP', 'message constant');
  const { deps: thrown } = deps(new Error('socket hang up'));
  const failed = await handleHook(post(body, await sign(body)), thrown);
  assert(JSON.stringify(await failed.json()) === JSON.stringify({ error: { http_code: 502, message: 'GENERIC' } }), 'thrown error not mapped');
});

Deno.test('payloads Auth would never send are refused without a send', async () => {
  for (const payload of ['not json', JSON.stringify({ sms: { otp: '12', phone: '919876543210' } }), JSON.stringify({ sms: { otp: 'abcdef', phone: '919876543210' } }),
    JSON.stringify({ sms: { otp: CODE, phone: '12' } }), JSON.stringify({ sms: { otp: CODE, phone: '+91 98765' } }), JSON.stringify({ sms: { otp: 482916, phone: '919876543210' } }), '{}']) {
    const { sends, deps: d } = deps();
    const response = await handleHook(post(payload, await sign(payload)), d);
    assert(response.status === 200 && (await response.json()).error?.http_code === 400 && sends.length === 0, `accepted ${payload.slice(0, 30)}`);
  }
  // The number may come from user.phone, with or without a plus sign.
  const { sends, deps: d } = deps();
  const payload = JSON.stringify({ user: { phone: '+919876543210' }, sms: { otp: CODE } });
  await handleHook(post(payload, await sign(payload)), d);
  assert(sends.length === 1 && sends[0][0] === '919876543210', 'user.phone fallback');
});

Deno.test('neither the code nor the number appears in any log, success or failure', async () => {
  for (const outcome of ['sent', 'not_on_whatsapp', 'rate_limited', 'provider_error', new Error(`boom ${CODE} 919876543210`)] as (SendOutcome | Error)[]) {
    const { deps: d } = deps(outcome);
    const { logs } = await capture(async () => await handleHook(post(body, await sign(body)), d));
    assert(!logs.includes(CODE) && !logs.includes('9876543210') && !logs.includes('boom'), `log leaks for ${String(outcome)}: ${logs}`);
  }
  const { logs } = await capture(async () => await handleHook(post(body, { ...(await sign(body)), 'webhook-id': 'forged' }), deps().deps));
  assert(!logs.includes(CODE), 'rejected request logged its code');
});

const config: Msg91Config = { authKey: 'test-auth-key', integratedNumber: '910000000000', templateName: 'login_code', namespace: 'test_namespace', languageCode: 'en' };
function mockFetch(status: number, reply: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => { calls.push({ url: String(url), init: init ?? {} }); if (reply instanceof Error) throw reply; return new Response(typeof reply === 'string' ? reply : JSON.stringify(reply), { status }); }) as typeof fetch;
  return { calls, fetcher };
}

Deno.test('MSG91 request carries the authentication template with the code in body and copy-code button', async () => {
  const { calls, fetcher } = mockFetch(200, { status: 'success', request_id: 'r1' });
  assert(await msg91Client(config, fetcher)('919876543210', CODE) === 'sent', 'success not reported');
  assert(calls.length === 1 && calls[0].url === 'https://api.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/bulk/', 'wrong endpoint');
  const headers = calls[0].init.headers as Record<string, string>;
  assert(calls[0].init.method === 'POST' && headers.authkey === 'test-auth-key', 'wrong method or key header');
  const request = JSON.parse(String(calls[0].init.body));
  assert(request.integrated_number === '910000000000' && request.content_type === 'template' && request.payload.messaging_product === 'whatsapp', 'wrong envelope');
  const template = request.payload.template;
  assert(template.name === 'login_code' && template.namespace === 'test_namespace' && template.language.code === 'en' && template.language.policy === 'deterministic', 'wrong template');
  const target = template.to_and_components;
  assert(target.length === 1 && target[0].to.length === 1 && target[0].to[0] === '919876543210', 'wrong recipient');
  assert(target[0].components.body_1.value === CODE && target[0].components.button_1.value === CODE && target[0].components.button_1.subtype === 'url', 'code not in body and button');
});

Deno.test('MSG91 failures map to not-on-WhatsApp, busy or provider error', async () => {
  const cases: [number, unknown, SendOutcome][] = [
    [200, { status: 'fail', message: 'Number is not registered on WhatsApp' }, 'not_on_whatsapp'],
    [400, { status: 'fail', errors: ['recipient is not a valid WhatsApp number'] }, 'not_on_whatsapp'],
    [422, { message: 'Invalid WhatsApp number' }, 'not_on_whatsapp'],
    [200, { status: 'error', message: 'template not approved' }, 'provider_error'],
    [200, { hasError: true, errors: 'something else' }, 'provider_error'],
    [401, { message: 'invalid authkey' }, 'provider_error'],
    [403, { message: 'not registered on whatsapp' }, 'provider_error'],
    [429, { message: 'slow down' }, 'rate_limited'],
    [500, 'upstream exploded', 'provider_error'],
    [503, {}, 'provider_error'],
  ];
  for (const [status, reply, expected] of cases) {
    const { fetcher } = mockFetch(status, reply);
    const outcome = await msg91Client(config, fetcher)('919876543210', CODE);
    assert(outcome === expected, `${status} ${JSON.stringify(reply)} gave ${outcome}, expected ${expected}`);
  }
  assert(await msg91Client(config, mockFetch(0, new Error('offline')).fetcher)('919876543210', CODE) === 'provider_error', 'network error');
  const { fetcher } = mockFetch(200, 'not json at all');
  assert(await msg91Client(config, fetcher)('919876543210', CODE) === 'sent', 'a 2xx with no JSON status is treated as accepted');
});

Deno.test('end to end: a signed hook request reaches the MSG91 mock once, and a bad one never does', async () => {
  const { calls, fetcher } = mockFetch(200, { status: 'success' });
  const real = { secret, now: () => NOW * 1000, send: msg91Client(config, fetcher) };
  const sent = () => calls.length;
  assert((await handleHook(post(body, { ...(await sign(body)), 'webhook-id': 'forged' }), real)).status === 401 && sent() === 0, 'forged request reached the provider');
  assert((await handleHook(post(body, await sign(body)), real)).status === 200 && sent() === 1, 'signed request not sent once');
});
