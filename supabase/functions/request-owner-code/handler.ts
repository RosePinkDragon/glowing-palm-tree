// Owner code request (#50). Public endpoint for the owners' app, so everything here is built so that the
// response never depends on whether the number belongs to an owner, whether a code was sent, whether the
// request was rate limited, or whether the provider failed. Only input and CAPTCHA errors differ, and those
// depend on nothing but the caller's own input.

export type Claim = { attemptId: string | null; isOwner: boolean; allowed: boolean };
export type Ports = {
  /** True when the CAPTCHA token is valid, or when no CAPTCHA secret is configured. */
  verifyCaptcha: (token: string | undefined, ip: string | null) => Promise<boolean>;
  /** Calls claim_owner_code_attempt as the service role. Logs the attempt. */
  claim: (input: { phone: string; slug: string; ip: string | null; app: string }) => Promise<Claim>;
  /** Asks Supabase Auth to send a code to an existing user (never creates one). Throws on any failure. */
  sendOtp: (phone: string) => Promise<void>;
  /** Records a provider failure for an authorised attempt. */
  markFailed: (attemptId: string) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  /** Keeps background work alive after the response (EdgeRuntime.waitUntil). */
  waitUntil: (work: Promise<unknown>) => void;
};
export type Config = { responseMs: number };

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-max-age': '86400',
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'content-type': 'application/json', 'cache-control': 'no-store' } });
// The one answer for every request that passed input and CAPTCHA checks.
const generic = () => json(200, { ok: true });
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Accepts a 10-digit Indian mobile number, optionally written with 0, 91 or +91 and spaces or hyphens. */
export function normalisePhone(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 32) return null;
  const compact = value.replace(/[\s-]/g, '');
  const match = /^(?:\+91|91|0)?([6-9][0-9]{9})$/.exec(compact);
  return match ? `+91${match[1]}` : null;
}

/** The caller's address as seen by Cloudflare in front of Supabase; null when no header carries one. */
export function clientIp(headers: Headers): string | null {
  const candidates = [headers.get('cf-connecting-ip'), headers.get('x-real-ip'), headers.get('x-forwarded-for')?.split(',')[0]];
  for (const candidate of candidates) {
    const value = candidate?.trim();
    if (value && value.length <= 45 && /^[0-9a-fA-F:.]+$/.test(value)) return value;
  }
  return null;
}

/** Cloudflare Turnstile server-side check. Any failure, including network errors, rejects the token. */
export function turnstileVerifier(secret: string, fetcher: typeof fetch = fetch): Ports['verifyCaptcha'] {
  return async (token, ip) => {
    if (!token || token.length > 2048) return false;
    try {
      const form = new URLSearchParams({ secret, response: token });
      if (ip) form.set('remoteip', ip);
      const res = await fetcher('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form, signal: AbortSignal.timeout(4000) });
      if (!res.ok) return false;
      return (await res.json())?.success === true;
    } catch {
      return false;
    }
  };
}

export async function handle(request: Request, ports: Ports, config: Config): Promise<Response> {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (request.method !== 'POST') return json(405, { ok: false, error: 'method_not_allowed' });

  let body: { phone?: unknown; slug?: unknown; captchaToken?: unknown };
  try {
    const text = await request.text();
    if (text.length > 4096) return json(400, { ok: false, error: 'invalid_request' });
    body = JSON.parse(text);
  } catch {
    return json(400, { ok: false, error: 'invalid_request' });
  }
  if (typeof body !== 'object' || body === null) return json(400, { ok: false, error: 'invalid_request' });
  const phone = normalisePhone(body.phone);
  if (!phone) return json(400, { ok: false, error: 'invalid_phone' });
  const slug = body.slug;
  if (typeof slug !== 'string' || slug.length > 50 || !SLUG.test(slug)) return json(400, { ok: false, error: 'invalid_request' });
  const ip = clientIp(request.headers);
  const token = typeof body.captchaToken === 'string' ? body.captchaToken : undefined;
  if (!await ports.verifyCaptcha(token, ip)) return json(400, { ok: false, error: 'captcha_failed' });

  // From here on every path ends in the same response, released at the same moment. The work (claim, and a
  // send for an authorised owner only) races a fixed delay; the response always waits out the delay, and work
  // that overruns it finishes in the background instead of changing the response time.
  const delay = ports.sleep(config.responseMs);
  const work = (async () => {
    try {
      const claim = await ports.claim({ phone, slug, ip, app: `${slug}-admin` });
      if (!claim.isOwner || !claim.allowed) return;
      try {
        await ports.sendOtp(phone);
      } catch {
        if (claim.attemptId) await ports.markFailed(claim.attemptId);
      }
    } catch {
      // Database trouble: nothing is sent, and the caller learns nothing. Never log the number or a code.
      console.error('owner code request: attempt could not be recorded');
    }
  })();
  await Promise.race([work, delay]);
  await delay;
  ports.waitUntil(work);
  return generic();
}
