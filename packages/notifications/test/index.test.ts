import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAnalytics, createMessaging, unavailableNativeMessaging, type EventName } from '../src/index.ts';

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
