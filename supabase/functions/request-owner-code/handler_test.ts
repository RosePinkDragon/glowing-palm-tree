import { captchaVerifier, clientIp, handle, normalisePhone, turnstileVerifier, type Claim, type Ports } from './handler.ts';

function assert(value: unknown, reason: string): asserts value { if (!value) throw new Error(reason); }
const config = { responseMs: 2000 };

type Calls = string[];
function fixture(claim: Claim | Error, overrides: Partial<Ports> = {}) {
  const calls: Calls = [];
  const claims: Parameters<Ports['claim']>[0][] = [];
  const background: Promise<unknown>[] = [];
  const ports: Ports = {
    verifyCaptcha: async () => { calls.push('captcha'); return true; },
    claim: async (input) => { calls.push('claim'); claims.push(input); if (claim instanceof Error) throw claim; return claim; },
    sendOtp: async () => { calls.push('send'); },
    markFailed: async (id) => { calls.push(`failed:${id}`); },
    sleep: async () => { calls.push('sleep'); },
    waitUntil: (work) => { background.push(work); },
    ...overrides,
  };
  return { calls, claims, background, ports };
}
const request = (body: unknown, headers: Record<string, string> = {}, method = 'POST') =>
  new Request('https://example.test/functions/v1/request-owner-code', { method, headers: { 'content-type': 'application/json', ...headers }, body: method === 'POST' ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined });
const valid = { phone: '98765 43210', slug: 'ammu-sammu', captchaToken: 'token' };
async function snapshot(response: Response) { return JSON.stringify({ status: response.status, body: await response.text(), headers: [...response.headers].sort() }); }

Deno.test('owner, non-owner, rate-limited, provider failure and database failure all get one identical response', async () => {
  const cases: [string, Claim | Error, Partial<Ports>][] = [
    ['owner', { attemptId: 'a1', isOwner: true, allowed: true }, {}],
    ['non-owner', { attemptId: 'a2', isOwner: false, allowed: true }, {}],
    ['owner rate limited', { attemptId: 'a3', isOwner: true, allowed: false }, {}],
    ['non-owner rate limited', { attemptId: null, isOwner: false, allowed: false }, {}],
    ['provider failure', { attemptId: 'a4', isOwner: true, allowed: true }, { sendOtp: async () => { throw new Error('provider down'); } }],
    ['database failure', new Error('database unavailable'), {}],
  ];
  const seen = new Set<string>();
  const quiet = console.error; console.error = () => {};
  try {
    for (const [name, claim, overrides] of cases) {
      const { ports } = fixture(claim, overrides);
      const response = await handle(request(valid), ports, config);
      assert(response.status === 200, `${name}: status`);
      seen.add(await snapshot(response));
    }
  } finally { console.error = quiet; }
  assert(seen.size === 1, `responses differ between cases: ${[...seen].join(' | ')}`);
  assert([...seen][0].includes('{\\"ok\\":true}'), 'unexpected generic body');
});

Deno.test('a code is requested from Auth only for an allowed owner, and exactly once', async () => {
  const sent: string[] = [];
  const sendOtp = async (phone: string) => { sent.push(phone); };
  for (const [claim, expected] of [
    [{ attemptId: 'a', isOwner: true, allowed: true }, 1], [{ attemptId: 'a', isOwner: false, allowed: true }, 0],
    [{ attemptId: 'a', isOwner: true, allowed: false }, 0], [{ attemptId: null, isOwner: false, allowed: false }, 0],
  ] as [Claim, number][]) {
    sent.length = 0;
    const { ports } = fixture(claim, { sendOtp });
    await handle(request(valid), ports, config);
    assert(sent.length === expected, `unexpected sends ${sent.length} for ${JSON.stringify(claim)}`);
    if (expected) assert(sent[0] === '+919876543210', 'normalised number not sent');
  }
  sent.length = 0;
  const { ports } = fixture(new Error('database unavailable'), { sendOtp });
  const quiet = console.error; console.error = () => {};
  try { await handle(request(valid), ports, config); } finally { console.error = quiet; }
  assert(sent.length === 0, 'send after a database failure');
});

Deno.test('provider failure is recorded against the attempt, and nothing else is', async () => {
  const failing = fixture({ attemptId: 'attempt-9', isOwner: true, allowed: true }, { sendOtp: async () => { throw new Error('provider down'); } });
  await handle(request(valid), failing.ports, config);
  assert(failing.calls.includes('failed:attempt-9'), 'failure not recorded');
  const fine = fixture({ attemptId: 'attempt-9', isOwner: true, allowed: true });
  await handle(request(valid), fine.ports, config);
  assert(!fine.calls.some((call) => call.startsWith('failed')), 'success recorded as failure');
});

Deno.test('every path waits for the same fixed delay, and an overrunning send cannot change the response time', async () => {
  for (const claim of [{ attemptId: 'a', isOwner: true, allowed: true }, { attemptId: 'b', isOwner: false, allowed: true }] as Claim[]) {
    let release!: () => void;
    const sleeps: number[] = [];
    const { ports } = fixture(claim, { sleep: (ms) => { sleeps.push(ms); return new Promise<void>((resolve) => { release = resolve; }); } });
    let done = false;
    const pending = handle(request(valid), ports, config).then((response) => { done = true; return response; });
    for (let i = 0; i < 20; i++) await Promise.resolve();
    assert(!done, `response released before the delay elapsed (${JSON.stringify(claim)})`);
    assert(sleeps.length === 1 && sleeps[0] === 2000, 'delay not the configured one');
    release();
    assert((await pending).status === 200, 'no response after the delay');
  }
  // A send that outlasts the delay: the response is released at the delay and the send finishes later.
  let finishSend!: () => void;
  let sendFinished = false;
  let wake!: () => void;
  const { ports, background } = fixture({ attemptId: 'a', isOwner: true, allowed: true }, {
    sleep: () => new Promise<void>((resolve) => { wake = resolve; }),
    sendOtp: () => new Promise<void>((resolve) => { finishSend = () => { sendFinished = true; resolve(); }; }),
  });
  const pending = handle(request(valid), ports, config);
  for (let i = 0; i < 20; i++) await Promise.resolve();
  wake();
  const response = await pending;
  assert(response.status === 200 && !sendFinished, 'slow send held up the response');
  assert(background.length === 1, 'slow send not handed to the runtime');
  finishSend();
  await background[0];
});

Deno.test('input errors are the caller\'s own and reach neither the database nor the provider', async () => {
  const bad: [unknown, number, string][] = [
    [{ ...valid, phone: '12345' }, 400, 'invalid_phone'], [{ ...valid, phone: '5876543210' }, 400, 'invalid_phone'],
    [{ ...valid, phone: undefined }, 400, 'invalid_phone'], [{ ...valid, phone: 9876543210 }, 400, 'invalid_phone'],
    [{ ...valid, slug: 'Ammu Sammu' }, 400, 'invalid_request'], [{ ...valid, slug: undefined }, 400, 'invalid_request'],
    [{ ...valid, slug: 'a'.repeat(51) }, 400, 'invalid_request'], ['not json', 400, 'invalid_request'], ['null', 400, 'invalid_request'],
    ['x'.repeat(5000), 400, 'invalid_request'],
  ];
  for (const [body, status, error] of bad) {
    const { ports, calls } = fixture({ attemptId: 'a', isOwner: true, allowed: true });
    const response = await handle(request(body), ports, config);
    assert(response.status === status && (await response.json()).error === error, `wrong answer for ${JSON.stringify(body)?.slice(0, 40)}`);
    assert(!calls.includes('claim') && !calls.includes('send'), 'input error reached a port');
  }
  for (const method of ['GET', 'PUT']) {
    const { ports, calls } = fixture({ attemptId: 'a', isOwner: true, allowed: true });
    assert((await handle(request(null, {}, method), ports, config)).status === 405 && calls.length === 0, `${method} accepted`);
  }
  const { ports } = fixture({ attemptId: 'a', isOwner: true, allowed: true });
  const preflight = await handle(request(null, {}, 'OPTIONS'), ports, config);
  assert(preflight.status === 204 && preflight.headers.get('access-control-allow-headers')?.includes('apikey') === true, 'preflight');
});

Deno.test('a failed CAPTCHA stops the request before any attempt is recorded', async () => {
  const { ports, calls } = fixture({ attemptId: 'a', isOwner: true, allowed: true }, { verifyCaptcha: async () => false });
  const response = await handle(request(valid), ports, config);
  assert(response.status === 400 && (await response.json()).error === 'captcha_failed', 'captcha failure not reported');
  assert(calls.length === 0 || !calls.includes('claim'), 'attempt recorded without CAPTCHA');
});

Deno.test('the CAPTCHA token and the caller address reach their ports; the claim gets the normalised number and app label', async () => {
  let seen: [string | undefined, string | null] | undefined;
  const { ports, claims } = fixture({ attemptId: 'a', isOwner: false, allowed: true }, { verifyCaptcha: async (token, ip) => { seen = [token, ip]; return true; } });
  await handle(request(valid, { 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '198.51.100.1, 10.0.0.1' }), ports, config);
  assert(seen?.[0] === 'token' && seen[1] === '203.0.113.7', 'captcha inputs');
  assert(JSON.stringify(claims[0]) === JSON.stringify({ phone: '+919876543210', slug: 'ammu-sammu', ip: '203.0.113.7', app: 'ammu-sammu-admin' }), `claim input ${JSON.stringify(claims[0])}`);
});

Deno.test('numbers are normalised to +91 and anything else is refused', () => {
  const ok = ['9876543210', '98765 43210', '98765-43210', '09876543210', '919876543210', '+919876543210', '+91 98765 43210'];
  for (const value of ok) assert(normalisePhone(value) === '+919876543210', `rejected ${value}`);
  for (const value of ['', '987654321', '98765432100', '5876543210', '+14155550123', '+9198765432101', 'abcdefghij', '+91-98765-4321x', null, 9876543210, {}]) {
    assert(normalisePhone(value) === null, `accepted ${String(value)}`);
  }
});

Deno.test('only Cloudflare\'s address header is trusted; forgeable headers and junk give no address', () => {
  assert(clientIp(new Headers({ 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '1.1.1.1', 'x-real-ip': '2.2.2.2' })) === '203.0.113.7', 'cf header');
  assert(clientIp(new Headers({ 'cf-connecting-ip': '2001:db8::1' })) === '2001:db8::1', 'ipv6');
  assert(clientIp(new Headers({ 'x-forwarded-for': '198.51.100.1, 10.0.0.1' })) === null, 'x-forwarded-for trusted');
  assert(clientIp(new Headers({ 'x-real-ip': '198.51.100.1' })) === null, 'x-real-ip trusted');
  assert(clientIp(new Headers({ 'cf-connecting-ip': "1.1.1.1'; drop table" })) === null, 'junk accepted');
  assert(clientIp(new Headers()) === null, 'absent header');
});

Deno.test('without a trusted address the claim gets none, so the database skips the per-IP limit', async () => {
  const { ports, claims } = fixture({ attemptId: 'a', isOwner: true, allowed: true });
  await handle(request(valid, { 'x-forwarded-for': '198.51.100.1', 'x-real-ip': '198.51.100.2' }), ports, config);
  assert(claims[0].ip === null, 'a forgeable header reached the claim');
});

Deno.test('CAPTCHA fails closed: no secret and no explicit opt-out refuses every request before any attempt is recorded', async () => {
  const quiet = console.error; const logs: string[] = []; console.error = (...a: unknown[]) => { logs.push(a.join(' ')); };
  try {
    for (const env of [{}, { secret: '' }, { optOut: '' }, { optOut: 'false' }, { optOut: 'OFF' }, { optOut: 'on' }]) {
      const { ports, calls } = fixture({ attemptId: 'a', isOwner: true, allowed: true }, { verifyCaptcha: captchaVerifier(env) });
      const response = await handle(request(valid), ports, config);
      assert(response.status === 503 && (await response.json()).error === 'unavailable', `not refused for ${JSON.stringify(env)}`);
      assert(!calls.includes('claim') && !calls.includes('send'), 'work happened without a CAPTCHA decision');
    }
  } finally { console.error = quiet; }
  assert(logs.length === 6 && logs.every((line) => line === 'owner code request: CAPTCHA is not configured'), `logs: ${logs.join('|')}`);
});

Deno.test('CAPTCHA wiring: the secret verifies with Turnstile, and only the explicit opt-out skips it', async () => {
  const asked: string[] = [];
  const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => { asked.push(String(init?.body)); return Response.json({ success: false }); }) as typeof fetch;
  const withSecret = fixture({ attemptId: 'a', isOwner: true, allowed: true }, { verifyCaptcha: captchaVerifier({ secret: 's', optOut: 'off' }, fetcher) });
  const refused = await handle(request(valid), withSecret.ports, config);
  assert(refused.status === 400 && (await refused.json()).error === 'captcha_failed' && asked.length === 1 && !withSecret.calls.includes('claim'), 'secret did not take precedence over the opt-out');
  const optedOut = fixture({ attemptId: 'a', isOwner: false, allowed: true }, { verifyCaptcha: captchaVerifier({ optOut: 'off' }, fetcher) });
  assert((await handle(request(valid), optedOut.ports, config)).status === 200 && optedOut.calls.includes('claim') && asked.length === 1, 'explicit opt-out did not skip the check');
});

Deno.test('Turnstile verification sends the secret, token and address, and fails closed', async () => {
  const requests: { url: string; body: string }[] = [];
  const answer = (result: unknown, ok = true) => (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), body: String(init?.body) });
    return new Response(JSON.stringify(result), { status: ok ? 200 : 500 });
  }) as typeof fetch;
  assert(await turnstileVerifier('secret-value', answer({ success: true }))('tok', '203.0.113.7'), 'valid token refused');
  const form = new URLSearchParams(requests[0].body);
  assert(requests[0].url === 'https://challenges.cloudflare.com/turnstile/v0/siteverify', 'wrong endpoint');
  assert(form.get('secret') === 'secret-value' && form.get('response') === 'tok' && form.get('remoteip') === '203.0.113.7', 'wrong form');
  assert(!await turnstileVerifier('s', answer({ success: false }))('tok', null), 'rejected token accepted');
  assert(!await turnstileVerifier('s', answer({ success: true }, false))('tok', null), 'provider error accepted');
  assert(!await turnstileVerifier('s', answer({ success: 'yes' }))('tok', null), 'non-boolean success accepted');
  assert(!await turnstileVerifier('s', (() => { throw new Error('offline'); }) as typeof fetch)('tok', null), 'network error accepted');
  const before = requests.length;
  assert(!await turnstileVerifier('s', answer({ success: true }))(undefined, null) && requests.length === before, 'missing token reached Cloudflare');
});

Deno.test('the database failure log carries no number', async () => {
  const lines: string[] = [];
  const quiet = console.error; console.error = (...args: unknown[]) => { lines.push(args.join(' ')); };
  try { await handle(request(valid), fixture(new Error('boom +919876543210')).ports, config); } finally { console.error = quiet; }
  assert(lines.length === 1 && !lines[0].includes('9876543210') && !lines[0].includes('boom'), `log leaks: ${lines.join('|')}`);
});
