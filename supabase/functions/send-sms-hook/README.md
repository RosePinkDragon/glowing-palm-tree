# Send SMS hook (WhatsApp code via MSG91)

Supabase Auth calls this function with every one-time code. Contract (from the `supabase/auth` source, `internal/hooks/hookshttp`,
and the Supabase "Send SMS Hook" guide): the request is signed with Standard Webhooks (`webhook-id`, `webhook-timestamp`,
`webhook-signature`, secret `v1,whsec_<base64>`) and carries `{user, sms: {otp, phone}}`; success is `200` with a JSON body (`{}`);
failure is `200` with `{"error": {"http_code": N, "message": "..."}}`, which Auth passes to the client with that status. Any other
status becomes a generic 500. The function verifies the signature and a five-minute timestamp window before reading the body, sends
the approved authentication template once through MSG91, and never logs the code, the number or the provider's reply.

Client-visible messages: `NOT_ON_WHATSAPP` (422, the number is not on WhatsApp), `RATE_LIMITED` (429), `GENERIC` (502 provider
error, 400 bad payload). `packages/services` maps them. MSG91 may accept a message and
report an unreachable number only in a later delivery report; only what the send call itself returns is classified here.

Run `deno test hook_test.ts` and `deno check index.ts` from this directory. Secret names are in `docs/RELEASE.md`.
