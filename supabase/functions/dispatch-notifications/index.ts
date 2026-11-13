import { dispatch, message, classify, type Job, type Ports } from './dispatch.ts';

const secret = Deno.env.get('NOTIFICATION_DISPATCH_SECRET') ?? '';
const supabase = Deno.env.get('SUPABASE_URL') ?? '';
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const accountText = Deno.env.get('FCM_SERVICE_ACCOUNT') ?? '';
const encoder = new TextEncoder();
const base64url = (data: Uint8Array) => btoa(String.fromCharCode(...data)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
const encoded = (value: unknown) => base64url(encoder.encode(JSON.stringify(value)));
async function timedFetch(url: string, init: RequestInit): Promise<Response> {
  return await fetch(url, { ...init, signal: AbortSignal.timeout(5000) });
}
async function oauth(account: { project_id: string; client_email: string; private_key: string }): Promise<string> {
  const body = account.private_key.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, '');
  const bytes = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', bytes, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${encoded({ alg: 'RS256', typ: 'JWT' })}.${encoded({ iss: account.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 })}`;
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, encoder.encode(unsigned));
  const assertion = `${unsigned}.${base64url(new Uint8Array(signature))}`;
  const res = await timedFetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }) });
  if (!res.ok) throw new Error('oauth unavailable');
  const result = await res.json();
  if (typeof result.access_token !== 'string' || !result.access_token) throw new Error('oauth unavailable');
  return result.access_token;
}
Deno.serve(async (request) => {
  // Build ports without contacting any provider. dispatch authenticates first.
  let account: { project_id: string; client_email: string; private_key: string } | undefined;
  try { account = JSON.parse(accountText); } catch { /* configuration checked below */ }
  const configured = !!supabase && !!serviceKey && !!account && typeof account.project_id === 'string' && /^[a-z0-9-]{1,63}$/.test(account.project_id) && typeof account.client_email === 'string' && !!account.client_email && typeof account.private_key === 'string' && !!account.private_key;
  let access: Promise<string> | undefined;
  async function rpc(name: string, payload: object): Promise<unknown> {
    if (!configured) throw new Error('not configured');
    const res = await timedFetch(`${supabase}/rest/v1/rpc/${name}`, { method: 'POST', headers: { apikey: serviceKey, authorization: `Bearer ${serviceKey}`, 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    if (!res.ok) throw new Error('database unavailable');
    return await res.json();
  }
  const ports: Ports = {
    claim: async () => await rpc('claim_notification_jobs', { p_limit: 5 }) as Job[],
    destination: async (job) => await rpc('notification_destination', { p_job_id: job.job_id, p_lease_id: job.lease_id }) as string | null,
    finish: async (job, result) => { await rpc('finish_notification_job', { p_job_id: job.job_id, p_lease_id: job.lease_id, p_result: result }); },
    send: async (token) => {
      if (!configured || !account) throw new Error('not configured');
      access ??= oauth(account);
      const bearer = await access;
      const res = await timedFetch(`https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`, { method: 'POST', headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' }, body: JSON.stringify(message(token)) });
      let body: unknown = null;
      try { body = await res.json(); } catch { /* Classification uses status if no JSON. */ }
      return classify(res.status, body);
    },
  };
  return await dispatch(request, secret, ports);
});
