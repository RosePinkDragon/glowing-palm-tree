export type Job = { job_id: string; lease_id: string };
export type Delivery = { token: string; order_id: string | null };
export type Result = 'sent' | 'retry' | 'unregistered' | 'discard';
export type Ports = {
  claim: () => Promise<Job[]>;
  destination: (job: Job) => Promise<Delivery | null>;
  finish: (job: Job, result: Result) => Promise<void>;
  send: (delivery: Delivery) => Promise<Result>;
};
const encoder = new TextEncoder();
async function authorized(provided: string, expected: string): Promise<boolean> {
  if (expected.length < 32) return false;
  const a = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(provided)));
  const b = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(expected)));
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
export async function dispatch(request: Request, secret: string, ports: Ports): Promise<Response> {
  if (request.method !== 'POST') return new Response(null, { status: 405 });
  const header = request.headers.get('authorization') ?? '';
  if (!await authorized(header, `Bearer ${secret}`) || secret.length < 32) return new Response(null, { status: 401 });
  try {
    const jobs = await ports.claim();
    for (const job of jobs) {
      try {
        const delivery = await ports.destination(job);
        const result = delivery ? await ports.send(delivery) : 'discard';
        await ports.finish(job, result);
      } catch {
        try { await ports.finish(job, 'retry'); } catch { /* Lease expiry permits recovery. */ }
      }
    }
    return new Response(null, { status: 204 });
  } catch {
    return new Response(null, { status: 503 });
  }
}
export function message(token: string, orderId?: string | null) {
  const data: Record<string, string> = { kind: 'order_changed' };
  if (orderId && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(orderId)) data.order_id = orderId;
  return { message: { token, data, android: { ttl: '0s' }, apns: { headers: { 'apns-expiration': '0' } }, webpush: { headers: { TTL: '0' } } } };
}
export function classify(status: number, body: unknown): Result {
  if (status >= 200 && status < 300) return 'sent';
  const error = (body as { error?: { details?: { errorCode?: string }[] } } | null)?.error;
  if (Array.isArray(error?.details) && error.details.some((d) => d?.errorCode === 'UNREGISTERED')) return 'unregistered';
  return status === 408 || status === 429 || status >= 500 || status === 401 || status === 403 ? 'retry' : 'discard';
}
