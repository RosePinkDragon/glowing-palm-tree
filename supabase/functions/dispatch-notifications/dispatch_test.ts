import { classify, dispatch, message, type Job, type Ports, type Result } from './dispatch.ts';
function assert(value: unknown, reason: string): asserts value { if (!value) throw new Error(reason); }
const secret = 'test-secret-with-at-least-32-characters';
const job: Job = { job_id: 'job', lease_id: 'lease' };
function fixture() {
  const calls: string[] = [];
  const ports: Ports = {
    claim: async () => { calls.push('claim'); return [job]; },
    destination: async () => { calls.push('destination'); return { token: 'opaque-token', order_id: null }; },
    send: async () => { calls.push('send'); return 'sent'; },
    finish: async (_job, result) => { calls.push(`finish:${result}`); },
  };
  return { calls, ports };
}
const request = (auth: string) => new Request('https://example.test/', { method: 'POST', headers: { authorization: auth } });
Deno.test('authentication precedes all database and provider work', async () => {
  const { calls, ports } = fixture();
  assert((await dispatch(request('Bearer wrong'), secret, ports)).status === 401, 'wrong secret accepted');
  assert((await dispatch(request(`Bearer ${secret}`), '', ports)).status === 401, 'missing secret accepted');
  assert(calls.length === 0, 'unauthorized request touched a port');
});
Deno.test('current recipient is checked before send and acknowledged', async () => {
  const { calls, ports } = fixture();
  assert((await dispatch(request(`Bearer ${secret}`), secret, ports)).status === 204, 'dispatch failed');
  assert(calls.join(',') === 'claim,destination,send,finish:sent', 'wrong dispatch sequence');
});
Deno.test('revoked recipient is discarded without a send', async () => {
  const { calls, ports } = fixture();
  ports.destination = async () => { calls.push('destination'); return null; };
  await dispatch(request(`Bearer ${secret}`), secret, ports);
  assert(calls.join(',') === 'claim,destination,finish:discard', 'revoked recipient sent');
});
Deno.test('provider failures retry and preserve lease identity', async () => {
  const { calls, ports } = fixture();
  ports.send = async () => { throw new Error('provider unavailable'); };
  ports.finish = async (actual, result) => { assert(actual === job, 'wrong lease'); calls.push(`finish:${result}`); };
  await dispatch(request(`Bearer ${secret}`), secret, ports);
  assert(calls.includes('finish:retry'), 'failure did not retry');
});
Deno.test('data message contains only generic hint and zero TTL', () => {
  const value = message('opaque-token');
  assert(JSON.stringify(value.message.data) === '{"kind":"order_changed"}', 'unexpected message data');
  assert(!('notification' in value.message), 'notification text included');
  assert(value.message.android.ttl === '0s' && value.message.webpush.headers.TTL === '0' && value.message.apns.headers['apns-expiration'] === '0', 'TTL not zero');
});
Deno.test('provider outcomes distinguish unregistered, temporary and permanent failures', () => {
  const cases: [number, unknown, Result][] = [
    [200, {}, 'sent'], [404, { error: { details: [{ errorCode: 'UNREGISTERED' }] } }, 'unregistered'],
    [429, {}, 'retry'], [503, {}, 'retry'], [403, {}, 'retry'], [400, {}, 'discard'],
  ];
  for (const [status, body, expected] of cases) assert(classify(status, body) === expected, `wrong classification ${status}`);
});

Deno.test('customer routing contains only a validated opaque order id', () => {
  const id = '40000000-0000-4000-8000-000000000001';
  const data = message('opaque-token', id).message.data;
  assert(JSON.stringify(data) === JSON.stringify({ kind: 'order_changed', order_id: id }), 'unexpected customer metadata');
  assert(!('order_id' in message('opaque-token', 'https://outside.test/').message.data), 'external path leaked');
  assert(!('order_id' in message('opaque-token', null).message.data), 'admin route changed');
});
