# Owner code request

Public endpoint for the owners' app: `POST {phone, slug, captchaToken}`. A 10-digit Indian number (optionally with 0, 91 or +91)
is normalised to +91, the Turnstile token is verified (`TURNSTILE_SECRET_KEY` is required: without it, and without the local-only opt-out `OWNER_CODE_CAPTCHA=off`, every request gets a 503), and `claim_owner_code_attempt` decides
ownership, applies the rate limits and writes the security log in one call. Only an admin member of that restaurant who is within
the limits makes the function ask Supabase Auth (`/auth/v1/otp`, `create_user: false`, service-role bearer) to send a code.

Every request that passes input and CAPTCHA checks gets the same `200 {"ok":true}` with the same headers, released after a fixed delay
(`OWNER_CODE_RESPONSE_MS`, default 2000 ms) whether the number is an owner, a non-owner, rate limited, refused by the provider or the
database failed. A send that outlasts the delay finishes in the background. Only malformed input and CAPTCHA failures differ (400),
and they depend on nothing but the caller's own request. Neither numbers nor codes are logged. Only `cf-connecting-ip` is trusted as the caller's address; without it the claim gets no address and the
per-IP limit is skipped.

Run `deno test handler_test.ts` and `deno check index.ts` from this directory. Required server values: `SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY` (provided by Supabase), plus the secrets in `docs/RELEASE.md`.
