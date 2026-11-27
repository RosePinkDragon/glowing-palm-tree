// Removes the Auth user of every account in deletion_pending (#51). Pure handler: all I/O goes through Ports so it can be tested
// without a network. It never logs or returns phone numbers, tokens, names or account ids, only fixed words and counts.
export type Pending = { customerId: string; requestedAt: string | null };
export type Prepared = 'pending' | 'gone' | 'not_pending';
export type Removal = 'deleted' | 'not_found';
export type Ports = {
  list: (limit: number) => Promise<Pending[]>;
  prepare: (customerId: string) => Promise<Prepared>;
  deleteAuthUser: (customerId: string) => Promise<Removal>;
  complete: (customerId: string, requestedAt: string | null) => Promise<boolean>;
  log: (line: string) => void;
};
export type Options = { batchSize?: number; maxRounds?: number; budgetMs?: number; now?: () => number };
export type Summary = { listed: number; deleted: number; already_gone: number; skipped: number; failed: number; complete: boolean };

const encoder = new TextEncoder();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Constant-time comparison of SHA-256 digests (the same pattern as dispatch-notifications).
async function authorized(provided: string, expected: string): Promise<boolean> {
  const a = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(provided)));
  const b = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(expected)));
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export const MIN_SECRET_LENGTH = 32;
export const clamp = (value: number, low: number, high: number, fallback: number) =>
  Number.isFinite(value) ? Math.min(Math.max(Math.trunc(value), low), high) : fallback;

export async function finish(ports: Ports, options: Options = {}): Promise<{ summary: Summary; listFailed: boolean }> {
  const batchSize = clamp(options.batchSize ?? 20, 1, 50, 20);
  const maxRounds = clamp(options.maxRounds ?? 5, 1, 20, 5);
  const now = options.now ?? Date.now;
  const deadline = now() + clamp(options.budgetMs ?? 100_000, 1000, 140_000, 100_000);
  const summary: Summary = { listed: 0, deleted: 0, already_gone: 0, skipped: 0, failed: 0, complete: false };
  // Accounts that failed or were skipped (not removed from the list) stay at the head of the list; ask for enough extra rows to look past them.
  const stuck = new Set<string>();
  rounds: for (let round = 0; round < maxRounds && now() < deadline; round++) {
    const asked = batchSize + stuck.size;
    let rows: Pending[];
    try { rows = await ports.list(asked); } catch { ports.log('finish-account-deletions: list failed'); return { summary, listFailed: true }; }
    const fresh = rows.filter((r) => !stuck.has(r.customerId)).slice(0, batchSize);
    if (fresh.length === 0) { summary.complete = true; break; }
    summary.listed += fresh.length;
    for (const [index, row] of fresh.entries()) {
      if (now() >= deadline) {
        summary.skipped += fresh.length - index;
        break rounds;
      }
      if (!UUID.test(row.customerId)) { summary.failed++; stuck.add(row.customerId); ports.log('finish-account-deletions: invalid id from list'); continue; }
      let step = 'prepare';
      try {
        // Cleanup again just before the Auth delete (late writes), under the account lock; it also refuses accounts not pending.
        const state = await ports.prepare(row.customerId);
        if (state === 'not_pending') { summary.skipped++; stuck.add(row.customerId); ports.log('finish-account-deletions: account not pending, left alone'); continue; }
        let removal: Removal = 'not_found';
        if (state === 'pending') { step = 'delete'; removal = await ports.deleteAuthUser(row.customerId); }
        step = 'complete';
        if (!await ports.complete(row.customerId, row.requestedAt)) throw new Error('auth user still present');
        if (removal === 'deleted') summary.deleted++; else summary.already_gone++;
      } catch {
        summary.failed++;
        stuck.add(row.customerId);
        ports.log(`finish-account-deletions: ${step} failed`);
      }
    }
    // A short page means the list is exhausted.
    if (rows.length < asked) { summary.complete = true; break; }
  }
  return { summary, listFailed: false };
}

export async function handle(request: Request, secret: string, ports: Ports, options: Options = {}): Promise<Response> {
  if (request.method !== 'POST') return new Response(null, { status: 405 });
  // Fails closed: a missing or short secret authorizes nobody, whatever the header holds.
  const header = request.headers.get('authorization') ?? '';
  const ok = await authorized(header, `Bearer ${secret}`);
  if (!ok || secret.length < MIN_SECRET_LENGTH) return new Response(null, { status: 401 });
  const { summary, listFailed } = await finish(ports, options);
  const status = listFailed ? 503 : summary.failed > 0 ? 500 : 200;
  return new Response(JSON.stringify(summary), { status, headers: { 'content-type': 'application/json' } });
}
