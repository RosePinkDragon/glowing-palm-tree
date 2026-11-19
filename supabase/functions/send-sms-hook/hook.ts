// Supabase Auth "Send SMS" hook (#50): receives each one-time code from Supabase Auth and sends it as a
// WhatsApp authentication template through MSG91. Contract (supabase/auth, internal/hooks/hookshttp):
//  - Auth POSTs JSON {metadata, user, sms: {otp, phone}} signed per Standard Webhooks
//    (webhook-id, webhook-timestamp, webhook-signature = "v1,<base64 HMAC-SHA256 of id.timestamp.body>").
//  - Success is HTTP 200 (or 204) with Content-Type application/json, e.g. {}.
//  - Failure is HTTP 200 with {"error": {"http_code": <status>, "message": "<text>"}}; Auth then answers the
//    client with that status and message. Any other status becomes a generic 500 "Unexpected status code".
// The code is never logged, stored or echoed, and neither is the phone number or the provider's response text.

export type SendOutcome = 'sent' | 'not_on_whatsapp' | 'rate_limited' | 'provider_error';
export type Send = (to: string, code: string) => Promise<SendOutcome>;
export type Deps = { secret: string; send: Send; now?: () => number };

// Stable messages the customer app maps to its own wording (see packages/services).
export const ERROR_MESSAGES = {
  not_on_whatsapp: { http_code: 422, message: 'NOT_ON_WHATSAPP' },
  rate_limited: { http_code: 429, message: 'RATE_LIMITED' },
  provider_error: { http_code: 502, message: 'GENERIC' },
  bad_payload: { http_code: 400, message: 'GENERIC' },
} as const;

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const failure = (error: { http_code: number; message: string }) => json(200, { error });
const TOLERANCE_SECONDS = 300;
const encoder = new TextEncoder();

function base64(value: string): Uint8Array<ArrayBuffer> | null {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(new ArrayBuffer(binary.length));
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch { return null; }
}

/** Standard Webhooks verification with the hook secret as Supabase shows it ("v1,whsec_<base64>"). */
export async function verifySignature(secret: string, headers: Headers, body: string, nowSeconds: number): Promise<boolean> {
  const id = headers.get('webhook-id'); const timestamp = headers.get('webhook-timestamp'); const signatures = headers.get('webhook-signature');
  if (!secret || !id || !timestamp || !signatures || !/^[0-9]{1,12}$/.test(timestamp)) return false;
  if (Math.abs(nowSeconds - Number(timestamp)) > TOLERANCE_SECONDS) return false;
  const keyBytes = base64(secret.replace(/^v1,/, '').replace(/^whsec_/, ''));
  if (!keyBytes || keyBytes.length < 16) return false;
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const signed = encoder.encode(`${id}.${timestamp}.${body}`);
  for (const candidate of signatures.split(' ')) {
    const [version, value] = candidate.split(',');
    const signature = version === 'v1' && value ? base64(value) : null;
    // subtle.verify compares in constant time.
    if (signature && await crypto.subtle.verify('HMAC', key, signature, signed)) return true;
  }
  return false;
}

export async function handleHook(request: Request, deps: Deps): Promise<Response> {
  if (request.method !== 'POST') return new Response(null, { status: 405 });
  const text = await request.text();
  const now = Math.floor((deps.now?.() ?? Date.now()) / 1000);
  // Authentication precedes parsing and every provider call.
  if (text.length > 16384 || !await verifySignature(deps.secret, request.headers, text, now)) return new Response(null, { status: 401 });
  let payload: { sms?: { otp?: unknown; phone?: unknown }; user?: { phone?: unknown } };
  try { payload = JSON.parse(text); } catch { return failure(ERROR_MESSAGES.bad_payload); }
  const code = payload?.sms?.otp;
  const phone = String(payload?.sms?.phone ?? payload?.user?.phone ?? '').replace(/^\+/, '');
  if (typeof code !== 'string' || !/^[0-9]{4,10}$/.test(code) || !/^[1-9][0-9]{7,14}$/.test(phone)) return failure(ERROR_MESSAGES.bad_payload);
  let outcome: SendOutcome;
  try { outcome = await deps.send(phone, code); } catch { outcome = 'provider_error'; }
  if (outcome === 'sent') return json(200, {});
  console.error(`send sms hook: provider outcome ${outcome}`);
  return failure(ERROR_MESSAGES[outcome]);
}

export type Msg91Config = { authKey: string; integratedNumber: string; templateName: string; namespace: string; languageCode: string };
const NOT_ON_WHATSAPP = /(not\s+(a\s+)?(registered|available|enabled|valid|using|on)\b[^.]{0,40}whatsapp)|(whatsapp[^.]{0,40}\b(not\s+(registered|available|enabled|valid|exist)|invalid))|(invalid\s+(whatsapp\s+)?(number|recipient))|(no\s+whatsapp\s+account)/i;

/**
 * MSG91 WhatsApp bulk template endpoint. `to` is digits with country code and no plus sign. The template is an
 * authentication template: the code fills the body variable and the copy-code button. MSG91 may accept a
 * message and report an unreachable number later through delivery reports; only what the send call itself
 * returns is classified here.
 */
export function msg91Client(config: Msg91Config, fetcher: typeof fetch = fetch): Send {
  return async (to, code) => {
    let res: Response;
    try {
      res = await fetcher('https://api.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/bulk/', {
        method: 'POST',
        headers: { authkey: config.authKey, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          integrated_number: config.integratedNumber,
          content_type: 'template',
          payload: {
            messaging_product: 'whatsapp',
            type: 'template',
            template: {
              name: config.templateName,
              language: { code: config.languageCode, policy: 'deterministic' },
              namespace: config.namespace,
              to_and_components: [{ to: [to], components: { body_1: { type: 'text', value: code }, button_1: { subtype: 'url', type: 'text', value: code } } }],
            },
          },
        }),
        signal: AbortSignal.timeout(4000), // Auth gives the hook 5 seconds.
      });
    } catch {
      return 'provider_error';
    }
    let body: unknown = null;
    try { body = await res.json(); } catch { /* classified by status below */ }
    const record = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    const status = typeof record.status === 'string' ? record.status.toLowerCase() : '';
    const failed = !res.ok || status === 'fail' || status === 'failed' || status === 'error' || record.hasError === true;
    if (!failed) return 'sent';
    if (res.status === 401 || res.status === 403) return 'provider_error';
    if (res.status === 429) return 'rate_limited';
    // The wording of the provider's reason is only inspected here, never logged or returned.
    const reason = [record.message, record.errors, record.error].map((v) => (typeof v === 'string' ? v : v ? JSON.stringify(v) : '')).join(' ').slice(0, 2000);
    return NOT_ON_WHATSAPP.test(reason) ? 'not_on_whatsapp' : 'provider_error';
  };
}
