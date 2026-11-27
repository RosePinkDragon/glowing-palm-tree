import { finish, handle, type Pending, type Ports, type Prepared, type Removal } from './finish.ts';
import { makePorts } from './ports.ts';

function assert(value: unknown, reason: string): asserts value { if (!value) throw new Error(reason); }
const secret = 'test-secret-with-at-least-32-characters';
const id = (n: number) => `52000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const request = (auth?: string, method = 'POST') => new Request('https://example.test/', { method, headers: auth ? { authorization: auth } : {} });

// A fake database: `pending` is the list (oldest first); removing a user drops it from the list, as the cascade does.
function fixture(count: number, overrides: { prepare?: (id: string) => Prepared; remove?: (id: string) => Removal | Error; complete?: (id: string) => boolean | Error } = {}) {
  const pending: Pending[] = Array.from({ length: count }, (_, i) => ({ customerId: id(i + 1), requestedAt: '2026-11-27T00:00:00Z' }));
  const calls: string[] = [];
  const logs: string[] = [];
  const asked: number[] = [];
  const ports: Ports = {
    list: async (limit) => { asked.push(limit); return pending.slice(0, limit); },
    prepare: async (who) => { calls.push(`prepare:${who}`); return overrides.prepare?.(who) ?? 'pending'; },
    deleteAuthUser: async (who) => {
      calls.push(`delete:${who}`);
      const r = overrides.remove?.(who) ?? 'deleted';
      if (r instanceof Error) throw r;
      pending.splice(pending.findIndex((p) => p.customerId === who), 1);
      return r;
    },
    complete: async (who) => {
      calls.push(`complete:${who}`);
      const r = overrides.complete?.(who) ?? true;
      if (r instanceof Error) throw r;
      const at = pending.findIndex((p) => p.customerId === who);
      if (at >= 0) pending.splice(at, 1);
      return r;
    },
    log: (line) => logs.push(line),
  };
  return { ports, calls, logs, asked, pending };
}
const body = async (r: Response) => await r.json();

Deno.test('authentication precedes all work and fails closed', async () => {
  const f = fixture(2);
  assert((await handle(request(), secret, f.ports)).status === 401, 'missing header accepted');
  assert((await handle(request('Bearer wrong'), secret, f.ports)).status === 401, 'wrong secret accepted');
  assert((await handle(request(secret), secret, f.ports)).status === 401, 'bare secret accepted');
  assert((await handle(request('Bearer '), '', f.ports)).status === 401, 'empty secret accepted');
  assert((await handle(request('Bearer short'), 'short', f.ports)).status === 401, 'short secret accepted');
  assert((await handle(request(`Bearer ${secret}`, 'GET'), secret, f.ports)).status === 405, 'GET accepted');
  assert(f.calls.length === 0 && f.asked.length === 0, 'unauthorized request touched a port');
});

Deno.test('success: cleanup, then Auth delete, then completion, in that order', async () => {
  const f = fixture(2);
  const res = await handle(request(`Bearer ${secret}`), secret, f.ports);
  assert(res.status === 200, 'not ok');
  const s = await body(res);
  assert(s.deleted === 2 && s.failed === 0 && s.already_gone === 0 && s.complete === true, 'wrong summary ' + JSON.stringify(s));
  assert(f.calls.join(',') === [1, 2].map((n) => `prepare:${id(n)},delete:${id(n)},complete:${id(n)}`).join(','), 'wrong order ' + f.calls.join(','));
});

Deno.test('a user already deleted (404) counts as done and is still completed', async () => {
  const f = fixture(1, { prepare: () => 'gone' });
  const s = (await finish(f.ports)).summary;
  assert(s.already_gone === 1 && s.deleted === 0 && s.failed === 0, 'gone not counted');
  assert(!f.calls.some((c) => c.startsWith('delete:')), 'deleted a user that is gone');
  const g = fixture(1, { remove: () => 'not_found' });
  const t = (await finish(g.ports)).summary;
  assert(t.already_gone === 1 && t.failed === 0 && g.calls.at(-1)?.startsWith('complete:'), 'admin 404 not treated as done');
});

Deno.test('an account that is not pending is never deleted', async () => {
  const f = fixture(1, { prepare: () => 'not_pending' });
  const s = (await finish(f.ports)).summary;
  assert(s.skipped === 1 && s.deleted === 0 && !f.calls.some((c) => c.startsWith('delete:')), 'deleted a non-pending account');
});

Deno.test('an Auth error fails that account only; the others finish and the status is 500', async () => {
  const f = fixture(3, { remove: (who) => who === id(2) ? new Error('auth refused') : 'deleted' });
  const res = await handle(request(`Bearer ${secret}`), secret, f.ports);
  const s = await body(res);
  assert(res.status === 500 && s.deleted === 2 && s.failed === 1, 'wrong result ' + JSON.stringify(s));
  assert(!f.calls.includes(`complete:${id(2)}`), 'completed a failed deletion');
  assert(f.calls.includes(`complete:${id(3)}`), 'later account not processed');
});

Deno.test('a cleanup RPC error skips the Auth delete for that account', async () => {
  const f = fixture(2, { prepare: (who) => { if (who === id(1)) throw new Error('database unavailable'); return 'pending'; } });
  const s = (await finish(f.ports)).summary;
  assert(s.failed === 1 && s.deleted === 1, 'wrong summary');
  assert(!f.calls.includes(`delete:${id(1)}`), 'deleted without cleanup');
});

Deno.test('completion that finds the user still present is a failure, not a success', async () => {
  const f = fixture(1, { complete: () => false });
  const s = (await finish(f.ports)).summary;
  assert(s.failed === 1 && s.deleted === 0, 'false completion counted');
});

Deno.test('a list failure answers 503 and does nothing else', async () => {
  const f = fixture(1);
  f.ports.list = async () => { throw new Error('database unavailable'); };
  assert((await handle(request(`Bearer ${secret}`), secret, f.ports)).status === 503, 'wrong status');
  assert(f.calls.length === 0, 'work after list failure');
});

Deno.test('batching: small pages, bounded rounds, failures do not loop forever', async () => {
  const f = fixture(7);
  const s = (await finish(f.ports, { batchSize: 3 })).summary;
  assert(s.deleted === 7 && s.complete, 'not all finished ' + JSON.stringify(s));
  assert(f.asked.every((n) => n === 3), 'page larger than the batch: ' + f.asked);
  // Bound: five rounds of 2 at most, the rest left for the next run.
  const g = fixture(30);
  const t = (await finish(g.ports, { batchSize: 2, maxRounds: 3 })).summary;
  assert(t.deleted === 6 && !t.complete && g.pending.length === 24, 'rounds not bounded ' + JSON.stringify(t));
  // Permanent failures sit at the head of the list; the loop looks past them and ends.
  const h = fixture(5, { remove: (who) => who === id(1) || who === id(2) ? new Error('auth refused') : 'deleted' });
  const u = (await finish(h.ports, { batchSize: 2, maxRounds: 10 })).summary;
  assert(u.deleted === 3 && u.failed === 2 && u.complete, 'failures not skipped ' + JSON.stringify(u));
  assert(h.calls.filter((c) => c === `prepare:${id(1)}`).length === 1, 'failed account retried within one run');
});

Deno.test('the time budget stops new work and reports it', async () => {
  let t = 0;
  const f = fixture(3);
  const s = (await finish(f.ports, { budgetMs: 1000, now: () => (t += 600) })).summary;
  assert(s.skipped >= 1 && s.deleted + s.skipped + s.failed === s.listed, 'budget ignored ' + JSON.stringify(s));
});

Deno.test('logs and responses carry no ids, phone numbers or tokens', async () => {
  const phone = '+919876543210';
  const token = 'eyJsecret.token';
  const f = fixture(2, { remove: () => new Error(`auth refused for ${phone} with ${token}`), prepare: (who) => { if (who === id(2)) throw new Error(`failed ${phone}`); return 'pending'; } });
  const res = await handle(request(`Bearer ${secret}`), secret, f.ports);
  const all = f.logs.join('\n') + JSON.stringify(await body(res));
  assert(f.logs.length === 2, 'expected two log lines');
  assert(!all.includes('9876543210') && !all.includes(token) && !all.includes(secret) && !all.includes('52000000'), 'sensitive text leaked: ' + all);
});

// The real ports over a fake fetch: URLs, methods, headers and body.
Deno.test('ports speak to the right endpoints with the service key and ignore bodies on errors', async () => {
  const seen: { url: string; method: string; auth: string; body: string }[] = [];
  const responses: Response[] = [
    Response.json([{ customer_id: id(1), requested_at: '2026-11-27T00:00:00Z' }]),
    Response.json('pending'),
    new Response('{"msg":"+919876543210"}', { status: 404 }),
    Response.json(true),
    new Response('secret body', { status: 500 }),
  ];
  const fake = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), method: init?.method ?? 'GET', auth: (init?.headers as Record<string, string>).authorization, body: String(init?.body ?? '') });
    return responses.shift()!;
  }) as typeof fetch;
  const lines: string[] = [];
  const ports = makePorts({ supabaseUrl: 'https://p.supabase.test/', serviceKey: 'svc-key', fetch: fake, log: (l) => lines.push(l) });
  const rows = await ports.list(5);
  assert(rows[0].customerId === id(1) && rows[0].requestedAt === '2026-11-27T00:00:00Z', 'list not mapped');
  assert(await ports.prepare(id(1)) === 'pending', 'prepare not mapped');
  assert(await ports.deleteAuthUser(id(1)) === 'not_found', '404 not mapped');
  assert(await ports.complete(id(1), null) === true, 'complete not mapped');
  let failed = '';
  try { await ports.deleteAuthUser(id(1)); } catch (e) { failed = (e as Error).message; }
  assert(failed === 'auth refused', 'auth error not raised');
  assert(!failed.includes('secret body'), 'response body in error');
  assert(seen[0].url === 'https://p.supabase.test/rest/v1/rpc/list_accounts_pending_auth_deletion' && seen[0].body === '{"p_limit":5}', 'list request');
  assert(seen[2].url === `https://p.supabase.test/auth/v1/admin/users/${id(1)}` && seen[2].method === 'DELETE', 'delete request');
  assert(seen.every((s) => s.auth === 'Bearer svc-key'), 'service key not sent');
  const unconfigured = makePorts({ supabaseUrl: '', serviceKey: '', fetch: fake });
  let refused = false;
  try { await unconfigured.list(1); } catch { refused = true; }
  assert(refused, 'unconfigured ports reached the network');
});
