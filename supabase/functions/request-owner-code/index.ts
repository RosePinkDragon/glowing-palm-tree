import { handle, turnstileVerifier, type Claim, type Ports } from './handler.ts';

declare const EdgeRuntime: { waitUntil(work: Promise<unknown>): void } | undefined;

const supabase = Deno.env.get('SUPABASE_URL') ?? '';
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const turnstileSecret = Deno.env.get('TURNSTILE_SECRET_KEY') ?? '';
const configuredDelay = Number(Deno.env.get('OWNER_CODE_RESPONSE_MS') ?? '2000');
// Long enough to hide the cost of a send, short enough to wait for. Bounded so a typo cannot stall logins.
const responseMs = Number.isFinite(configuredDelay) ? Math.min(Math.max(configuredDelay, 500), 8000) : 2000;

async function timedFetch(url: string, init: RequestInit): Promise<Response> {
  return await fetch(url, { ...init, signal: AbortSignal.timeout(6000) });
}
const headers = { apikey: serviceKey, authorization: `Bearer ${serviceKey}`, 'content-type': 'application/json' };

const ports: Ports = {
  // Without a secret (local development only) the check is skipped; production sets it, see docs/RELEASE.md.
  verifyCaptcha: turnstileSecret ? turnstileVerifier(turnstileSecret) : async () => true,
  claim: async ({ phone, slug, ip, app }): Promise<Claim> => {
    if (!supabase || !serviceKey) throw new Error('not configured');
    const res = await timedFetch(`${supabase}/rest/v1/rpc/claim_owner_code_attempt`, {
      method: 'POST', headers, body: JSON.stringify({ p_phone: phone, p_business_slug: slug, p_ip: ip, p_app: app }),
    });
    if (!res.ok) throw new Error('database unavailable');
    const rows = await res.json();
    const row = Array.isArray(rows) ? rows[0] : rows;
    if (typeof row?.is_owner !== 'boolean' || typeof row?.allowed !== 'boolean') throw new Error('unexpected claim result');
    return { attemptId: typeof row.attempt_id === 'string' ? row.attempt_id : null, isOwner: row.is_owner, allowed: row.allowed };
  },
  // create_user: false is the REST name of signInWithOtp's shouldCreateUser: false. The service-role bearer
  // is an admin credential, so Auth skips its own CAPTCHA requirement, which this function already enforced.
  sendOtp: async (phone) => {
    const res = await timedFetch(`${supabase}/auth/v1/otp`, { method: 'POST', headers, body: JSON.stringify({ phone, create_user: false }) });
    if (!res.ok) throw new Error('auth refused the code');
  },
  markFailed: async (attemptId) => {
    const res = await timedFetch(`${supabase}/rest/v1/rpc/mark_owner_code_failed`, { method: 'POST', headers, body: JSON.stringify({ p_attempt_id: attemptId }) });
    if (!res.ok) throw new Error('database unavailable');
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  waitUntil: (work) => { if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(work); },
};

Deno.serve((request) => handle(request, ports, { responseMs }));
