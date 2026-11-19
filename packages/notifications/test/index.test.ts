import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAnalytics, createEventOnce, createMessaging, createMonitoring, reportError, scrubBreadcrumb, scrubEvent, scrubText, setErrorReporter, setTracer, traced, unavailableNativeMessaging, type EventName } from '../src/index.ts';
import { createWebErrorReporting, createWebPerformance, webSentryOptions } from '../src/web.ts';

test('analytics waits for explicit consent and only forwards allowlisted context and events', async () => {
  const calls: unknown[] = [];
  const analytics = createAnalytics({ async enable() { calls.push('enable'); }, async disable() { calls.push('disable'); }, send(name, context) { calls.push([name, context]); } }, { brand: 'ammu_sammu', audience: 'customer', email: 'private@example.com' } as never);
  assert.equal(await analytics.track('app_open'), false);
  assert.deepEqual(calls, []);
  await analytics.setConsent(true);
  assert.equal(await analytics.track('app_open'), true);
  assert.equal(await analytics.track('private text' as EventName), false);
  await analytics.setConsent(false);
  assert.equal(await analytics.track('menu_view'), false);
  assert.deepEqual(calls, ['enable', ['app_open', { brand: 'ammu_sammu', audience: 'customer' }], 'disable']);
});

test('notification events require successful analytics consent and stop after withdrawal', async () => {
  const calls: string[] = [];
  const analytics = createAnalytics({ async enable() { calls.push('enable'); }, async disable() { calls.push('disable'); }, send(name) { calls.push(name); } }, { brand: 'ammu_sammu', audience: 'customer' });
  assert.equal(await analytics.track('notifications_enabled'), false);
  await analytics.setConsent(true);
  assert.equal(await analytics.track('app_open'), true);
  assert.equal(await analytics.track('notifications_enabled'), true);
  await analytics.setConsent(false);
  assert.equal(await analytics.track('notifications_enabled'), false);
  assert.deepEqual(calls, ['enable', 'app_open', 'notifications_enabled', 'disable']);
});

test('withdrawal during initialization prevents a queued event', async () => {
  let finish!: () => void;
  const calls: string[] = [];
  const analytics = createAnalytics({ enable: () => new Promise<void>(resolve => { finish = resolve; }), async disable() { calls.push('disable'); }, send() { calls.push('send'); } }, { brand: 'ammu_sammu', audience: 'customer' });
  const enabling = analytics.setConsent(true);
  await new Promise<void>(resolve => setImmediate(resolve));
  const tracking = analytics.track('app_open');
  const withdrawing = analytics.setConsent(false);
  finish();
  await Promise.all([enabling, withdrawing]);
  assert.equal(await tracking, false);
  assert.ok(calls.includes('disable'));
  assert.ok(!calls.includes('send'));
});

test('token rotation and account switch remove prior ownership, logout removes before deleting token', async () => {
  const calls: string[] = [];
  let token = 'first';
  const messaging = createMessaging({ async requestToken() { return { status: 'ready', token }; }, async resumeToken() { return { status: 'denied', reason: 'not granted' }; }, async deleteToken() { calls.push('delete'); }, onHint() { return () => {}; } }, { async register(user, value) { calls.push(`add:${user}:${value}`); }, async remove(user, value) { calls.push(`remove:${user}:${value}`); } });
  assert.equal((await messaging.enable('a')).status, 'ready');
  token = 'second';
  await messaging.enable('a');
  await messaging.enable('b');
  await messaging.disable();
  assert.deepEqual(calls, ['add:a:first', 'remove:a:first', 'add:a:second', 'remove:a:second', 'add:b:second', 'remove:b:second', 'delete']);
});

test('logout invalidates pending permission and native is explicitly unavailable', async () => {
  let finish!: (result: { status: 'ready'; token: string }) => void;
  const calls: string[] = [];
  const messaging = createMessaging({ requestToken: () => new Promise(resolve => { finish = resolve; }), async resumeToken() { return { status: 'denied', reason: 'not granted' }; }, async deleteToken() { calls.push('delete'); }, onHint() { return () => {}; } }, { async register() { calls.push('add'); }, async remove() { calls.push('remove'); } });
  const enabling = messaging.enable('a');
  const disabling = messaging.disable();
  finish({ status: 'ready', token: 'token' });
  assert.equal((await enabling).status, 'error');
  await disabling;
  assert.deepEqual(calls, ['delete']);
  assert.equal((await unavailableNativeMessaging().requestToken()).status, 'unsupported');
});

test('failed backend removal is retained for a retry', async () => {
  let fail = true;
  const calls: string[] = [];
  const messaging = createMessaging({ async requestToken() { return { status: 'ready', token: 't' }; }, async resumeToken() { return { status: 'denied', reason: 'not granted' }; }, async deleteToken() { calls.push('delete'); }, onHint() { return () => {}; } }, { async register() {}, async remove() { calls.push('remove'); if (fail) throw new Error('offline'); } });
  await messaging.enable('a');
  await assert.rejects(messaging.disable(), /offline/);
  fail = false;
  await messaging.disable();
  assert.deepEqual(calls, ['remove', 'remove', 'delete']);
});

test('web analytics fails closed without verified stream policy before SDK initialization', async () => {
  const { createWebAnalytics } = await import('../src/web.ts');
  const config = { apiKey: 'public', projectId: 'project', appId: 'app', messagingSenderId: 'sender', measurementId: 'G-test' };
  await assert.rejects(createWebAnalytics(config).enable(), /Enhanced Measurement.*explicitly verified/);
  await assert.rejects(createWebAnalytics(config, { enhancedMeasurementDisabled: false }).enable(), /Enhanced Measurement.*explicitly verified/);
});


test('restore never requests permission and rebinds the authenticated session', async () => {
  const calls: string[] = [];
  const messaging = createMessaging({ async requestToken() { calls.push('prompt'); return { status: 'ready', token: 't' }; }, async resumeToken() { calls.push('resume'); return { status: 'ready', token: 't' }; }, async deleteToken() {}, onHint() { return () => {}; } }, { async register(user, token) { calls.push(`${user}:${token}`); }, async remove() {} });
  await messaging.resume('a'); await messaging.resume('a');
  assert.deepEqual(calls, ['resume', 'a:t', 'resume', 'a:t']);
});

test('logout during in-flight registration removes the registration', async () => {
  let finish!: () => void; const calls: string[] = [];
  const messaging = createMessaging({ async requestToken() { return { status: 'ready', token: 't' }; }, async resumeToken() { return { status: 'ready', token: 't' }; }, async deleteToken() { calls.push('delete'); }, onHint() { return () => {}; } }, { async register() { calls.push('register'); await new Promise<void>(resolve => { finish = resolve; }); }, async remove() { calls.push('remove'); } });
  const enabling = messaging.enable('a');
  await new Promise<void>(resolve => setImmediate(resolve));
  const logout = messaging.disable(); finish();
  assert.equal((await enabling).status, 'error'); await logout;
  assert.deepEqual(calls, ['register', 'remove', 'delete']);
});

test('speed monitoring loads nothing before consent and stops on withdrawal', async () => {
  const calls: string[] = [];
  const monitoring = createMonitoring([{ async enable() { calls.push('enable'); }, async disable() { calls.push('disable'); } }]);
  assert.deepEqual(calls, []);
  await monitoring.setConsent(true);
  await monitoring.setConsent(false);
  assert.deepEqual(calls, ['enable', 'disable']);
});

test('speed monitoring withdrawal during start disables it and a failing port never rejects', async () => {
  let finish!: () => void;
  const calls: string[] = [];
  const monitoring = createMonitoring([{ enable: () => new Promise<void>(resolve => { finish = resolve; }), async disable() { calls.push('disable'); } }, { async enable() { throw new Error('unconfigured'); }, async disable() { calls.push('disable-failed'); } }]);
  const starting = monitoring.setConsent(true);
  await new Promise<void>(resolve => setImmediate(resolve));
  const withdrawing = monitoring.setConsent(false);
  finish();
  await Promise.all([starting, withdrawing]);
  // Disabling twice is harmless; what matters is that both ports end disabled and a throwing port never rejects.
  assert.deepEqual([...new Set(calls)].sort(), ['disable', 'disable-failed']);
});

test('the web performance adapter does not load or install a tracer without configuration', async () => {
  const performance = createWebPerformance({});
  await assert.rejects(performance.enable(), /not configured/);
  let ran = false;
  assert.equal(await traced('checkout_submit', async () => { ran = true; return 7; }), 7);
  assert.equal(ran, true);
  await performance.disable();
});

test('traced records names only, stops on failure and ignores tracer faults', async () => {
  const events: string[] = [];
  setTracer(name => { events.push(`start ${name}`); return () => events.push(`stop ${name}`); });
  assert.equal(await traced('otp_request', async () => 'ok'), 'ok');
  await assert.rejects(traced('photo_upload', async () => { throw new Error('upload failed'); }), /upload failed/);
  assert.deepEqual(events, ['start otp_request', 'stop otp_request', 'start photo_upload', 'stop photo_upload']);
  setTracer(() => { throw new Error('tracer broke'); });
  assert.equal(await traced('otp_verify', async () => 'still runs'), 'still runs');
  setTracer(undefined);
  assert.equal(await traced('otp_verify', async () => 'no tracer'), 'no tracer');
  assert.deepEqual(events.length, 4);
});

test('events fire once, even when called twice at the same moment as under StrictMode', async () => {
  const sent: string[] = [];
  const once = createEventOnce(async name => { await Promise.resolve(); sent.push(name); return true; });
  await Promise.all([once.fire('menu_view'), once.fire('menu_view')]);
  await once.fire('menu_view');
  await once.fire('ordering_started');
  await once.fire('ordering_started');
  assert.deepEqual(sent, ['menu_view', 'ordering_started']);
});

test('order_completed is once per order and an unsent event can be retried after consent', async () => {
  const sent: string[] = [];
  let consent = false;
  const once = createEventOnce(async name => { if (!consent) return false; sent.push(name); return true; });
  await once.fire('menu_view');
  assert.deepEqual(sent, []);
  consent = true;
  await once.fire('menu_view');
  await once.fire('menu_view');
  await once.fire('order_completed', 'order-1');
  await once.fire('order_completed', 'order-1');
  await once.fire('order_completed', 'order-2');
  assert.deepEqual(sent, ['menu_view', 'order_completed', 'order_completed']);
  const failing = createEventOnce(async () => { throw new Error('init failed'); });
  await failing.fire('menu_view');
});

test('scrubText strips URL query strings and fragments', () => {
  assert.equal(scrubText('https://shop.example.com/orders/abc?token=secret&phone=1#frag'), 'https://shop.example.com/orders/abc');
  assert.equal(scrubText('Failed to load https://x.supabase.co/rest/v1/orders?select=*&id=eq.1 now'), 'Failed to load https://x.supabase.co/rest/v1/orders now');
  assert.equal(scrubText('/cart?next=%2Faccount'), '/cart');
});

test('scrubText redacts Indian phone numbers, emails and code-like numbers', () => {
  for (const phone of ['9876543210', '+919876543210', '+91 98765 43210', '+91-9876543210', '919876543210', '09876543210', '98765 43210']) assert.equal(scrubText(`call ${phone} now`), 'call [phone] now', phone);
  assert.equal(scrubText('mail priya.k+test@example.co.in please'), 'mail [email] please');
  assert.equal(scrubText('OTP 123456 and code 4821 and 12345678'), 'OTP [code] and code [code] and [code]');
  assert.equal(scrubText('a 123 b 123456789'), 'a 123 b 123456789');
  assert.equal(scrubText('Something went wrong'), 'Something went wrong');
});

test('scrubEvent removes identity and request payloads and scrubs every string, including breadcrumbs', () => {
  const event = {
    message: 'Order for 9876543210 failed, code 123456',
    user: { id: 'u1', email: 'a@b.com', ip_address: '1.2.3.4' },
    request: { url: 'https://shop.example.com/login?phone=9876543210#x', method: 'POST', data: { phone: '9876543210' }, cookies: { s: 'x' }, headers: { Cookie: 'x' }, query_string: 'phone=9876543210' },
    exception: { values: [{ type: 'Error', value: 'bad email test@example.com', stacktrace: { frames: [{ filename: 'https://shop.example.com/index.js?v=1', lineno: 12345 }] } }] },
    breadcrumbs: [{ category: 'fetch', message: 'GET https://x.supabase.co/rest/v1/a?phone=eq.9876543210', data: { url: 'https://x.supabase.co/a?b=1', status_code: 200 } }],
    tags: { release: 'v1' },
  };
  const clean = scrubEvent(event);
  assert.equal(clean.user, undefined);
  assert.deepEqual(clean.request, { url: 'https://shop.example.com/login', method: 'POST' });
  assert.equal(clean.message, 'Order for [phone] failed, code [code]');
  assert.equal(clean.exception.values[0].value, 'bad email [email]');
  assert.equal(clean.exception.values[0].stacktrace.frames[0].filename, 'https://shop.example.com/index.js');
  assert.equal(clean.exception.values[0].stacktrace.frames[0].lineno, 12345);
  assert.equal(clean.breadcrumbs[0].message, 'GET https://x.supabase.co/rest/v1/a');
  assert.equal(clean.breadcrumbs[0].data.url, 'https://x.supabase.co/a');
  assert.equal(clean.breadcrumbs[0].data.status_code, 200);
  assert.equal(clean.tags.release, 'v1');
  assert.ok(!JSON.stringify(clean).match(/9876543210|123456|test@example|a@b\.com|1\.2\.3\.4|\?/));
  assert.equal((event.request as { url: string }).url.includes('?'), true, 'the input is not modified');
  assert.deepEqual(scrubBreadcrumb({ category: 'ui.click', message: 'tap 9876543210' }), { category: 'ui.click', message: 'tap [phone]' });
});

test('Sentry options switch off personal data, replay and tracing and scrub in both hooks', () => {
  const options = webSentryOptions({ dsn: 'https://key@o1.ingest.sentry.io/1', environment: 'production', release: 'abc123' });
  assert.deepEqual(options.dataCollection, { userInfo: false, cookies: false, httpHeaders: false, httpBodies: [], urlQueryParams: false });
  assert.equal(options.tracesSampleRate, 0);
  assert.equal('replaysSessionSampleRate' in options, false);
  assert.equal(options.environment, 'production');
  assert.equal(options.release, 'abc123');
  const sent = options.beforeSend!({ message: 'x 9876543210', request: { url: 'https://a.b/c?d=1' } } as never, {} as never) as { message: string; request: { url: string } };
  assert.equal(sent.message, 'x [phone]');
  assert.equal(sent.request.url, 'https://a.b/c');
  assert.equal((options.beforeBreadcrumb!({ message: 'a@b.com' } as never, undefined) as { message: string }).message, '[email]');
});

test('error reports load nothing without a DSN and do nothing without an installed reporter', async () => {
  const reports = createWebErrorReporting({});
  await assert.rejects(reports.enable(), /not configured/);
  const seen: unknown[] = [];
  reportError(new Error('before consent'));
  setErrorReporter(error => seen.push(error));
  reportError('during');
  await reports.disable();
  reportError('after withdrawal');
  assert.deepEqual(seen, ['during']);
  setErrorReporter(() => { throw new Error('reporter broke'); });
  reportError('never throws');
  setErrorReporter(undefined);
});
