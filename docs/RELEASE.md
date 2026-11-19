# Release setup

This repository does not create provider projects, configure credentials, or deploy the apps. Never commit private credentials or send them in chat. Public client configuration can be entered in Vercel's environment settings. Complete and verify the provider and launch steps below before accepting real orders.

## Web launch runbook (owner)

This is the one ordered checklist for a web-only launch on your own Supabase project and Vercel. Work top to bottom; later steps depend on earlier ones. Agents never deploy, link a Supabase project or run `supabase db push`: you run the commands below from a trusted machine. Detail and rationale for each step is in the sections further down; native builds (EAS) are out of scope here. Anything marked **confirm in dashboard** is not defined by this repository.

Before you start: the customer and owners' WhatsApp sign-in screens (#50 slices B and C) are on `main`; deploy from a `main` commit that includes them, because the apps cannot sign in without them.

**Never run `supabase config push` for this repository.** It would push CAPTCHA off, a local hook address and fictional test OTPs (valid code `123456`) to the hosted project. Configure hosted Auth in the dashboard only.

### 1. Create the Supabase project and push the database

1. In the Supabase dashboard create a new, empty project. Note the project ref, the Project URL (**Connect**) and the publishable (or legacy `anon`) key (**Project Settings → API Keys**). Never use or expose the service-role key in Vercel.
2. From a trusted machine: `supabase login`, then `supabase link --project-ref <project-ref>`. Check the printed ref is the new project and not another one (the two `dukan-dar` projects are unrelated Prisma databases and must never be linked).
3. Run `supabase db push`. On an empty project this applies only `supabase/migrations/20261117000000_baseline.sql` (schema, no data). Do not use `supabase/seed.sql`; it is demonstration data.
4. Create the two businesses and set kitchen points and the 12 km delivery radius with the SQL in [Supabase and launch data](#supabase-and-launch-data), step 5. `order_prefix` cannot be changed afterwards. Leave `ordering_enabled` false until the staging checks in step 9 pass, then enable ordering per business (**confirm in dashboard** or SQL editor; this is the existing owner setting).
5. Migrations are now forward-only: see [Migration policy](#migration-policy-frozen). Any later schema change is a new timestamped file.

### 2. Deploy the Edge Functions

From the same linked machine:

```
supabase functions deploy request-owner-code
supabase functions deploy send-sms-hook
supabase functions deploy menu-photos --use-docker
```

All three functions are required for the web launch. `request-owner-code` and `send-sms-hook` are required for login. `menu-photos` is required because owners use it to upload dish photos (`packages/services`); run `deno install --frozen` in `supabase/functions/menu-photos` first as its README describes, then deploy it with Docker bundling: Docker must be running, because API-only bundling drops the static `magick.wasm` (`static_files` in `supabase/config.toml`) and the function would fail. The flag is `--use-docker` (check `supabase functions deploy --help` for the Docker bundling flag on your CLI version). `dispatch-notifications` is not part of the web launch (step 5). Their `verify_jwt = false` settings come from `supabase/config.toml` and each function authenticates itself.

### 3. Secrets (names only)

Set from a trusted machine with `supabase secrets set --env-file <untracked file>`. Never commit the file, paste values in chat, or put them in Vercel.

| Secret | Function | Required |
| --- | --- | --- |
| `SEND_SMS_HOOK_SECRET` | `send-sms-hook` | Yes. Value comes from step 4 (`v1,whsec_...`); set it in the same sitting as enabling the hook |
| `MSG91_AUTH_KEY` | `send-sms-hook` | Yes |
| `MSG91_WHATSAPP_NUMBER` | `send-sms-hook` | Yes |
| `MSG91_TEMPLATE_NAME` | `send-sms-hook` | Yes |
| `MSG91_TEMPLATE_NAMESPACE` | `send-sms-hook` | Yes |
| `MSG91_TEMPLATE_LANGUAGE` | `send-sms-hook` | Optional, default `en` |
| `TURNSTILE_SECRET_KEY` | `request-owner-code` | Yes; without it every owner code request gets a 503 |
| `OWNER_CODE_RESPONSE_MS` | `request-owner-code` | Optional, default 2000 |
| `OWNER_CODE_CAPTCHA` | `request-owner-code` | Never on hosted; local development only |

Not part of the web launch (native push is tracked in #54): the Firebase secrets `FCM_SERVICE_ACCOUNT` and `NOTIFICATION_DISPATCH_SECRET` for `dispatch-notifications`. Do not set them for this launch.

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are read by the functions too; the platform supplies them to deployed functions (**confirm in dashboard** under Edge Functions → Secrets). The provider accounts (Meta business verification, MSG91 WhatsApp authentication template with copy-code button, Cloudflare Turnstile widget for the four production domains) take days; see [WhatsApp provider setup](#provider-setup-do-first-approvals-take-days).

### 4. Hosted Auth settings (dashboard only)

1. Authentication → Hooks → **Send SMS**: HTTPS, the URL of `send-sms-hook`, generate the secret and store it as `SEND_SMS_HOOK_SECRET` immediately; enable the hook in that same sitting.
2. Authentication → Providers → **Phone**: enable; SMS OTP expiry **600** seconds, length 6, resend interval (`max_frequency`) **30** seconds. Keep the project SMS rate limit modest.
3. Authentication → Bot and Abuse Protection: enable CAPTCHA with **Turnstile** and the secret, at the same time as setting `EXPO_PUBLIC_TURNSTILE_SITE_KEY` in all four Vercel projects (step 7). If only one side is set, every login-code request fails.
4. Authentication → URL Configuration: Site URL and the four exact production domain roots as Redirect URLs, no broad wildcards.

### 5. Push notifications: not part of the web launch

Not part of the web launch (native push is tracked in #54). Do not deploy `dispatch-notifications`, set its Firebase secrets or configure a scheduler for this launch. For later reference, the push setup is described in [Firebase, analytics, and notifications](#firebase-analytics-and-notifications): deploy `dispatch-notifications`, set `FCM_SERVICE_ACCOUNT` and `NOTIFICATION_DISPATCH_SECRET`, and configure a trusted scheduler (**confirm in dashboard**; none is provided by this repository).

### 6. Production owner accounts

Create each owner with a phone number (Authentication → Users → Add user with the phone, confirmed; or `auth.admin.createUser({ phone: '+91XXXXXXXXXX', phone_confirm: true })` from a trusted machine), then add the membership in the SQL editor. Use the real numbers only there; never in the repository.

```sql
insert into public.business_memberships (business_id, user_id, role, display_name)
select b.id, u.id, 'admin', 'Owner' from public.businesses b, auth.users u
where b.slug = 'ammu-sammu' and u.phone = '<digits with country code, no plus>';
```

Repeat with `b.slug = 'kokani-dine-inn'` for the other business.

### 7. Four Vercel projects

Import the repository four times with the Vercel GitHub integration (no deploy token needed). Each project takes the settings below; the commands come from each app's `vercel.json`, so confirm they appear in the project and do not override them.

| Vercel project | Root Directory | Build command (from `vercel.json`) | Rewrites |
| --- | --- | --- | --- |
| Ammu Sammu customer | `apps/ammu-sammu-customer` | `cd ../.. && npm run build:web --workspace ammu-sammu-customer` | `/cart`, `/orders`, `/orders/:id`, `/account`, `/login`, `/addresses`, `/help`, `/privacy`, `/terms` to `/index.html` |
| Ammu Sammu admin | `apps/ammu-sammu-admin` | `cd ../.. && npm run build:web --workspace ammu-sammu-admin` | none (root page) |
| Kokani Dine Inn customer | `apps/kokani-dine-inn-customer` | `cd ../.. && npm run build:web --workspace kokani-dine-inn-customer` | same as the Ammu customer app |
| Kokani Dine Inn admin | `apps/kokani-dine-inn-admin` | `cd ../.. && npm run build:web --workspace kokani-dine-inn-admin` | none (root page) |

For all four: Framework Preset **Other**, Node.js **24.x**, Production Branch `main`, install command `cd ../.. && npm ci`, output directory `dist/web`, and **Include source files outside of the Root Directory in the Build Step** enabled. The rewrites and the `Cache-Control: public, max-age=0, must-revalidate` header for `/firebase-messaging-worker.js` already live in the `vercel.json` files; add nothing in the dashboard.

Environment variables (Production; public values only, the same for all four unless noted):

| Variable | Value |
| --- | --- |
| `EXPO_PUBLIC_SUPABASE_URL` | Project URL from step 1 |
| `EXPO_PUBLIC_SUPABASE_ANON_KEY` | Publishable key from step 1 |
| `EXPO_PUBLIC_TURNSTILE_SITE_KEY` | Turnstile site key. Must be set in all four Vercel projects and Supabase Auth CAPTCHA (Turnstile) enabled together, at the same time. If only one side is set, every login-code request fails |
| `EXPO_PUBLIC_FIREBASE_API_KEY`, `_PROJECT_ID`, `_MESSAGING_SENDER_ID`, `_APP_ID`, `_MEASUREMENT_ID`, `_VAPID_KEY`, `_ANALYTICS_STREAM_VERIFIED` | Not part of the web launch (step 5); leave unset. Each app uses its own Firebase web app config; the verified flag stays `false` until Enhanced Measurement is confirmed off |
| `EXPO_PUBLIC_WEB_BASE_PATH` | Leave blank (or `/`) |

`EXPO_PUBLIC_EAS_PROJECT_ID` is not used for web. Variables are baked in at build time, so redeploy after changing any. Add each project's production domain to the Supabase redirect URLs (step 4) and to the Turnstile widget. You trigger the deploys; agents do not.

### 8. Purges (retention)

The baseline has exactly two purge functions, both callable only by `service_role` (and by `postgres` in the SQL editor), and nothing schedules them:

- `public.purge_expired_owner_login_attempts()` removes `owner_login_attempts` rows older than 90 days.
- `public.purge_expired_customer_notifications()` removes customer notification feed rows older than 30 days (reads already hide them).

`public.purge_customer_notifications(...)` is internal to the leave-restaurant flow; do not schedule it.

Optional, pg_cron (enable it in Database → Extensions or Integrations; **confirm in dashboard** that jobs run as `postgres`):

```sql
create extension if not exists pg_cron;
select cron.schedule('purge-owner-login-attempts', '17 3 * * *', $$select public.purge_expired_owner_login_attempts()$$);
select cron.schedule('purge-customer-notifications', '27 3 * * *', $$select public.purge_expired_customer_notifications()$$);
```

Manual fallback, run now and then (monthly is plenty) in the SQL editor:

```sql
select public.purge_expired_owner_login_attempts();
select public.purge_expired_customer_notifications();
```

Each returns the number of rows removed. Until one of these is arranged, retention is not live.

### 9. Post-deploy staging checks

Do these on the deployed domains before enabling ordering for real customers. Use real numbers only on your own devices.

1. Request a code as a tester from a known network, then in the SQL editor run `select ip, outcome, created_at from public.owner_login_attempts order by created_at desc limit 5;`. The `ip` must be non-null and equal the tester's real public address. If it is null, record it as a launch follow-up (the per-IP limit is not running).
2. A customer code arrives on WhatsApp and logs in a new number.
3. An owner's number receives a code in the owners' app; a non-owner number sees the identical screen and no message appears in the MSG91 log.
4. A number that is not on WhatsApp gets the "could not deliver" error (customer only).
5. CAPTCHA works: with it on, a request without a valid token is refused and a normal one succeeds.
6. Place an order end to end on each brand (Ammu Sammu and Kokani Dine Inn): sign in, add to cart, checkout inside the delivery area, see it in that brand's admin app, move it through the order statuses. Confirm an address outside 12 km is refused.
7. Inspect `/firebase-messaging-worker.js` on each domain for the revalidating `Cache-Control` header.
8. For each brand, an owner uploads a dish photo in the owners' app and it appears on the customer menu.
9. Then enable `ordering_enabled` for each business and report the live URLs only after this browser verification.

### 10. Rollback

- Web: in Vercel, promote the previous good deployment of the affected project (Deployments → previous → Promote / Instant Rollback; **confirm in dashboard**). Environment variable changes need a redeploy.
- Stop orders without rolling anything back by setting `ordering_enabled` (and `accepting_orders`) to false for the business.
- Database: forward-only. Never edit or reset the baseline or a database holding real data; fix problems with a new timestamped migration, applied with `supabase db push`.
- Login: if codes fail after a settings change, check the hook secret still matches `SEND_SMS_HOOK_SECRET`, CAPTCHA and site key agree, and the Auth logs; fix the setting rather than disabling protections.
- Secrets: rotate an exposed secret in its provider first, then re-set it with `supabase secrets set`.

## Reference: web, four Vercel projects

Connect the GitHub repository using the Vercel GitHub integration and import it four times, one project per row. Select a Vercel plan appropriate for the intended commercial use; review [Vercel's plan terms](https://vercel.com/pricing) before choosing. This setup uses the integration, so no `VERCEL_TOKEN` or GitHub Actions deployment secret is needed.

| Project / app | Root Directory |
| --- | --- |
| Ammu Sammu customer | `apps/ammu-sammu-customer` |
| Ammu Sammu admin | `apps/ammu-sammu-admin` |
| Kokani Dine Inn customer | `apps/kokani-dine-inn-customer` |
| Kokani Dine Inn admin | `apps/kokani-dine-inn-admin` |

For each import, set Framework Preset to **Other**, Node.js Version to **24.x**, Production Branch to `main`, and enable **Include source files outside of the Root Directory in the Build Step** in the Root Directory settings. The app's `vercel.json` supplies the install command `cd ../.. && npm ci`, build command `cd ../.. && npm run build:web --workspace <app>` (with that app's workspace name), and output directory `dist/web` relative to the app root. Confirm these settings in the project before deploying. Use a separate domain or Vercel project domain for each app; leave `EXPO_PUBLIC_WEB_BASE_PATH` blank or set it to `/`.

In each project's Settings → Environment Variables, set the public values from `.env.example` for the appropriate environment before building. Apply production values to Production; use a separate staging provider project and values for Preview where possible. Public variables are embedded in the exported client. Each app receives the same Supabase URL and publishable key for the intended environment and its own Firebase web app configuration. `EXPO_PUBLIC_EAS_PROJECT_ID` is for EAS, not required for a web deployment. Redeploy after changing build-time variables. The integration deploys `main` to production and can create preview deployments for branches and pull requests. Restrict previews and only allow trusted preview URLs in authentication settings.

The export places `firebase-messaging-worker.js` at the same-origin root. The configuration requires revalidation of this worker so updates can reach browsers. Keep the customer apps' route rewrites in `vercel.json` so direct navigation and reloads on `/cart`, `/orders`, `/orders/:id`, `/account`, and `/login` serve the exported app. The admin apps use the root page. After deployment, open each domain, verify its callback, and inspect the root worker response and its `Cache-Control` header. Report a live URL only after deployment and browser verification.

## GitHub branch protection

A repository administrator should open GitHub **Settings → Branches** (branch protection rules) or **Settings → Rules → Rulesets** and protect `main`: require pull requests, require passing checks (`Delivery policy`, `quality`, `export`, `tests`, `policy`, `postgis-rls`, `dispatcher`, and `browser`), require branches to be up to date before merging, and disallow force pushes. Select the intended check sources where available and consult [the repository workflow](WORKFLOW.md) for enforcement limits and review policy. These protections are account settings and are not established by this repository.

A formal GitHub approval requires a distinct eligible reviewer; agent review reports or PR comments are not GitHub approvals, and the PR author cannot approve their own PR. Arrange an eligible reviewer before requiring formal approval or CODEOWNERS review so the rule is workable.

## Supabase and launch data

1. Create one Supabase project for the intended environment. In the dashboard, use **Connect** for the Project URL and **Project Settings → API Keys** for the publishable key (the legacy `anon` key also works). Set `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_ANON_KEY` in all four Vercel projects. These are public client values; never expose the service-role key.
2. From a trusted machine, authenticate the Supabase CLI, link the intended project with `supabase link --project-ref <project-ref>`, review the target and migrations, then run `supabase db push`. On a fresh project this applies the single baseline, `supabase/migrations/20261117000000_baseline.sql`. It creates the schema and no data: no restaurant, menu, kitchen point or delivery area rows. Both businesses share this database; verify row-level security and cross-business isolation with appropriate accounts. `supabase/seed.sql` is demonstration data, not a production catalog or verified boundary; don't use it as launch data. Keep business and menu `is_demo` flags consistent with real, reviewed data.
3. Configure **Supabase Auth** and its implemented sign-in method. In Authentication → URL Configuration, add the four exact production domain roots to Redirect URLs; add only current trusted preview roots if previews need authentication. A separate staging project is preferable for previews. Set the Site URL appropriately and verify sign-in and callback on each app. Avoid broad preview wildcards.
4. Through a trusted administrative database setup, create the appropriate `business_memberships` for authenticated admin users and verify each admin can access only their business. Do not distribute service credentials to clients.
5. Create the real launch restaurant rows, then confirm each business's delivery area before enabling ordering. A fresh project has no restaurant rows, so checkout fails closed until trusted setup supplies them. From a trusted administrative connection (the Supabase SQL editor runs as `postgres`), insert the minimal rows. Only `slug`, `name` and `order_prefix` have no default; `is_demo`, `ordering_enabled` and `accepting_orders` default to false and `id` is generated:

```sql
insert into public.businesses (slug, name, order_prefix, is_demo) values
  ('ammu-sammu', 'Ammu Sammu', 'AMS', false),
  ('kokani-dine-inn', 'Kokani Dine Inn', 'KDI', false);
```

**Warning: `order_prefix` is immutable.** It must match `^[A-Z][A-Z0-9]{1,9}$` (two to ten characters, an uppercase letter first, then uppercase letters or digits) and be unique. It becomes the start of every order number (for example `AMS-2026110001`), and a database trigger rejects any later change to it. Choose it once and carefully; the apps, tests and seed use `AMS` and `KDI`. Do not insert a row with a placeholder prefix. Also set contact phone numbers, delivery fee and minimum order through the owner settings or a trusted update, and leave `ordering_enabled` false until the delivery area below is set.

The owner's delivery decision (16 Nov 2026) is 12 km around each restaurant's kitchen point. After the rows exist, run this as a trusted role for each Khed restaurant (kitchen points supplied by the owner on 16 Nov 2026 from Google Maps pins; longitude first):

```sql
update public.businesses set kitchen_location = extensions.st_setsrid(extensions.st_makepoint(73.3944946, 17.7190154), 4326) where slug = 'ammu-sammu';
update public.businesses set kitchen_location = extensions.st_setsrid(extensions.st_makepoint(73.3988110, 17.7197215), 4326) where slug = 'kokani-dine-inn';
select public.set_delivery_radius('ammu-sammu', 12000, 'Owner decision 16 Nov 2026: deliver within 12 km of the kitchen');
select public.set_delivery_radius('kokani-dine-inn', 12000, 'Owner decision 16 Nov 2026: deliver within 12 km of the kitchen');
```

PostGIS schema: the SQL above uses `extensions.`, which is where Supabase installs PostGIS. Check with `select extnamespace::regnamespace from pg_extension where extname = 'postgis';`. If it returns `public` (PostGIS was already installed there), change `extensions.st_setsrid` and `extensions.st_makepoint` to `public.st_setsrid` and `public.st_makepoint` (or drop the prefix). `set_delivery_radius` looks up the schema itself and needs no change. `tests/database/saved-addresses.sql` runs these same statements against both layouts. The seed (`supabase/seed.sql`) sets the same kitchen points for the demonstration rows only and creates no delivery area. `set_delivery_radius` records the source, the version (`radius-12000m`) and the verification time; it does not change `ordering_enabled`. If a kitchen point is moved later, run `set_delivery_radius` again; the area does not follow it. For a new restaurant (for example in Dapoli), insert its row, set its `kitchen_location`, then run `select public.set_delivery_radius('<slug>', <metres>, '<who decided, and when>');`. A drawn boundary can still replace a circle by setting `service_area` and those three fields directly. Confirm actual menu items and prices, delivery fees, minimum orders, and cash-on-delivery terms with the businesses. Replace demo data, review `is_demo` and `ordering_enabled`, and test the server-enforced checkout and geographic boundary before enabling real orders.

## Migration policy (frozen)

Tracked by issue #131; frozen for the web launch under #15. `supabase/migrations/20261117000000_baseline.sql` is the single baseline (it replaced the 17 development migrations, squashed in #131 slice S3). The policy is now **frozen**: the baseline version and the commit that fixed its content are recorded in `supabase/migration-policy.json`:

```json
{ "mode": "frozen", "baseline": { "version": "20261117000000", "commit": "b946a2db742dcc543b3ea8bbb3a2b97c1fa9fc5d" } }
```

The freeze is recorded at release cutover, before the baseline is pushed to the owner's new Supabase project (runbook step 1). Local disposable PostgreSQL/PostGIS runs in tests do not count as applying it.

The mode lives in `supabase/migration-policy.json` and is checked by `npm run pr:preflight` (author-run before publishing; the mode is read from `main`, so a PR cannot loosen its own rules). The trusted `Delivery policy` CI check also applies this guard, reading the policy pinned to a resolved main commit rather than using the PR's proposed policy. Unprivileged App CI separately validates that the checked-in proposed file is a JSON object with a known mode and, for `frozen`, a baseline with a 14-digit `version` and a 40-character lowercase `commit`, so malformed configuration cannot poison later trusted runs. The freeze takes effect for other PRs once this change merges into main.

| Mode | Meaning | Guard |
| --- | --- | --- |
| `pre-release-open` | Squash not yet done; feature PRs may still add migration files. | Warns on added migration files. |
| `pre-release-baseline` | One baseline exists and is not yet applied anywhere persistent. Fold schema changes into it. | Fails when a PR adds a file under `supabase/migrations/`. Override with a `Migration-Policy-Override: <reason>` line in the PR body. |
| `frozen` (current) | Baseline applied or about to be applied to a persistent environment. Forward-only. | Fails when a PR modifies, deletes or renames an existing migration file, including the baseline. A new file must be named `<14-digit timestamp>_<name>.sql` (lowercase letters, digits, underscores) with a timestamp after the baseline version. No override. |

Rules:

- Never edit the baseline. Change the schema only by adding a new timestamped migration, then apply it with `supabase db push` from a trusted machine.
- Never rewrite, reorder or delete applied migration history, and never reset a database holding real data to comply with this policy.
- The two `dukan-dar` Supabase projects are separate Prisma-managed databases. Never link, push to or otherwise change them. Verify the intended project ref and its migration history are new and empty before any database write.
- `supabase config push` is never used (see the runbook).

Release-readiness gate after the push (runbook steps 1 and 9):

1. Verify seed and reference data, security (RLS, tenant isolation, grants, Supabase advisers), roles and memberships, the `menu-images` storage bucket, Realtime publications, and the critical flows (checkout, order transitions, notifications).
2. If the baseline push must be abandoned on a project that has received no real data, discard the project and create a new one; do not edit the baseline.

## Customer notification feed (#55 backend)

The baseline writes one private customer feed entry per order status event in the same
transaction as the order. It is independent of push consent, device count and push retries.
The feed is deliberately excluded from Realtime, including DELETE events. Restaurant
owners cannot read the feed for their restaurant, even if they also placed an order.
The customer screen remains separate work.

Customer reads hide rows older than 30 days. A trusted server caller can execute
`public.purge_expired_customer_notifications()` to delete expired rows; it returns the
number removed and retries safely. EXECUTE is granted only to `service_role`, never
anon or authenticated clients. **There is no pg_cron installation, automatic cleanup,
remote schedule, or live retention job in this change.** The owner explicitly limited
this backend delivery to a trusted-callable cleanup function. A future separately
authorized operator must arrange and verify regular invocation before claiming that
scheduled retention is live. Never put a service-role key in an app.

For the later #51/#52 lifecycle stages, the trusted-only
`public.purge_customer_notifications(user_id, business_id, created_before)` removes
one customer's entries through a durable cutoff; NULL business means both restaurants.
Call it under the shared lifecycle lock using the original request's persisted start
cutoff, so a retried leave cannot erase a later rejoin's entries. Account deletion also
has an `auth.users` delete cascade. These hooks do not implement account deletion or
restaurant leave: those issues must integrate and test their own staged cleanup.
No remote Supabase project is linked or changed by these repository changes.

## Firebase, analytics, and notifications

1. Create one Firebase project for the environment and register four web apps, one per target. In Firebase Console → Project settings → General → Your apps, select each web app and copy its public config into the matching Vercel project's `EXPO_PUBLIC_FIREBASE_API_KEY`, `PROJECT_ID`, `MESSAGING_SENDER_ID`, and `APP_ID` variables. The prefix for each is `EXPO_PUBLIC_FIREBASE_`. Firebase client config is public; control access through provider settings and security rules. Supabase provides authentication for these apps.
2. For analytics, find the web app's measurement ID in its Firebase web config or Google Analytics → Admin → Data streams → the web stream, and set `EXPO_PUBLIC_FIREBASE_MEASUREMENT_ID`. In that same stream turn **Enhanced Measurement** off, verify it is off for the actual stream, and only then set `EXPO_PUBLIC_FIREBASE_ANALYTICS_STREAM_VERIFIED=true`. Leave it false until verified. Analytics also requires user consent.
3. For web push, find or generate the public Web Push certificate key pair in Firebase Console → Project settings → Cloud Messaging → Web Push certificates and set its public key as `EXPO_PUBLIC_FIREBASE_VAPID_KEY`. Configure Firebase Cloud Messaging for the project. Verify permission, token registration, and delivery on each deployed origin.
4. Deploy `dispatch-notifications` with the Supabase CLI from a trusted machine after linking the correct project: `supabase functions deploy dispatch-notifications`. In Firebase Console → Project settings → Service accounts, choose **Generate new private key** on a trusted machine. Upload the resulting JSON as the Supabase Edge Function secret `FCM_SERVICE_ACCOUNT` (it contains `project_id`, `client_email`, and `private_key`), and store a strong `NOTIFICATION_DISPATCH_SECRET` of at least 32 characters in Supabase Edge Function secrets. The function also uses Supabase's server-side `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. Keep these private values out of chat, GitHub, and Vercel frontend variables. Configure a trusted scheduler to POST to the deployed function URL with `Authorization: Bearer <NOTIFICATION_DISPATCH_SECRET>`; the function checks that secret and has JWT verification disabled specifically for this endpoint. Verify scheduling and delivery without exposing the secret. See [function notes](../supabase/functions/dispatch-notifications/README.md).

## WhatsApp one-time-code login (#50, backend)

Customers and owners sign in with a mobile number and a 6-digit code sent as a WhatsApp authentication message.
This section covers the backend and provider setup; the customer and owner screens ship separately (#50 slices B and C),
and Android autofill follows with the first native build. Nothing here creates a provider account or deploys anything.

**Existing email accounts start fresh.** The email-and-password accounts made before launch are pre-release fixtures, so
there is no migration. Production owners are created with their phone number at deploy (see below). The email functions
stay in `services.auth` until the screens switch.

**How it fits together.** Customers call Supabase Auth (`signInWithOtp`, then `verifyOtp` with type `sms`). Auth generates
the code and posts it to the `send-sms-hook` Edge Function, which verifies the signed request and sends the template
through MSG91. Owners never call Auth for a code: the owners' app calls `request-owner-code`, which checks the number
against `business_memberships` for that restaurant and asks Auth to send a code (without creating a user) only for an admin
member. Every other request to that endpoint is logged and answered identically (the endpoint's own response; see the cooldown
limit under Rate limits below for what Auth's resend timer can still reveal). A verified code only matters to an owner if the account
is an admin member: access still comes from `business_memberships`, checked on the server.

### Provider setup (do first; approvals take days)

1. Meta Business verification for the Indian business, and a WhatsApp Business number registered to that business, so codes
   to Indian numbers are billed at the domestic authentication rate.
2. In MSG91, connect the WhatsApp Business account and note the integrated WhatsApp number.
3. Create an **authentication** template in Meta (through MSG91) with the code in the body and the **copy code** button, so iOS and
   web users get one-tap copy. For Android one-tap autofill the template also needs the app's package name and signature hash;
   add them when the native build exists (a template edit is re-reviewed by Meta). Write down the exact template name,
   namespace and language code once approved. The function sends the code to the body variable and the button.
4. Cloudflare Turnstile: create a widget for the four production domains. The **site key** is public: set it as
   `EXPO_PUBLIC_TURNSTILE_SITE_KEY` in all four Vercel projects and redeploy (the screens, slices B and C, send a token as `captchaToken`
   only when this variable is set). The **secret key** goes in both places below. The two sides must agree: with the site key set,
   enable CAPTCHA in Auth and set `TURNSTILE_SECRET_KEY`; with no site key the screens send no token, so CAPTCHA must stay off in
   Auth (as it is in the local `supabase/config.toml`) or every code request is refused.

### Secrets (names only; never in git, chat or a Vercel frontend variable)

Set these as Supabase Edge Function secrets from a trusted machine (`supabase secrets set --env-file <untracked file>`):

| Secret | Used by | Value |
| --- | --- | --- |
| `SEND_SMS_HOOK_SECRET` | `send-sms-hook` | The hook secret the dashboard generates (`v1,whsec_...`) |
| `MSG91_AUTH_KEY` | `send-sms-hook` | MSG91 auth key |
| `MSG91_WHATSAPP_NUMBER` | `send-sms-hook` | The integrated WhatsApp number, digits with country code |
| `MSG91_TEMPLATE_NAME` | `send-sms-hook` | Approved template name |
| `MSG91_TEMPLATE_NAMESPACE` | `send-sms-hook` | Template namespace shown by MSG91/Meta |
| `MSG91_TEMPLATE_LANGUAGE` | `send-sms-hook` | Optional template language code, default `en` |
| `TURNSTILE_SECRET_KEY` | `request-owner-code` | Turnstile secret. **Required in production, together with the site key.** The function fails closed: without it every request gets a 503 and a fixed log line |
| `OWNER_CODE_CAPTCHA` | `request-owner-code` | Local development only: `off` skips the CAPTCHA check when no secret is set. Put it only in the untracked local env file passed to `supabase functions serve`; never set it on a hosted project |
| `OWNER_CODE_RESPONSE_MS` | `request-owner-code` | Optional fixed response time, default 2000, kept between 500 and 8000 |

### Enable it (hosted project)

1. Deploy: `supabase functions deploy send-sms-hook` and `supabase functions deploy request-owner-code` (both have JWT verification
   off in `supabase/config.toml`; each authenticates itself).
2. Authentication → **Hooks** → Send SMS: HTTPS, the URL of `send-sms-hook`, generate the secret, and store it as `SEND_SMS_HOOK_SECRET`.
   **Enable the hook and store the secret in the same sitting**: a hook that is enabled before the function has its secret (or a secret
   that no longer matches) makes every code request fail. Auth signs every call (Standard Webhooks) and the function rejects anything unsigned or older than five minutes.
3. Authentication → Providers → **Phone**: enable it. No SMS provider is needed with the hook. Set **SMS OTP expiry to 600**
   seconds (10 minutes; the default is far longer), length 6, and the resend interval (minimum time between codes, `max_frequency`) to **30 seconds**, the cooldown the screens show by default. Leave the project SMS rate
   limit modest (`auth.rate_limit.sms_sent`); it also caps WhatsApp spend on the customer path.
4. Authentication → **Bot and Abuse Protection**: enable CAPTCHA with Turnstile and the same secret (only together with
   `EXPO_PUBLIC_TURNSTILE_SITE_KEY`, see provider setup step 4). The customer screens send a token with each code request. Auth skips its own CAPTCHA check for the service-role call that `request-owner-code`
   makes, because that function has already verified the token itself.
5. `supabase/config.toml` carries the same settings for the local stack (OTP expiry 600, resend interval 30 seconds, hook, CAPTCHA
   off by default with Cloudflare's test keys documented in the file, two fictional test numbers that skip the hook and accept `123456`). **Never run `supabase config push` for this repository**: it would push
   CAPTCHA off, the local hook address and the fictional test OTPs (making those codes valid on the hosted project). Configure hosted
   Auth in the dashboard only. For local functions, put `OWNER_CODE_CAPTCHA=off` (or a Turnstile test secret) in the untracked env file.
6. Verify on staging before launch: a customer code arrives and logs in a new number; a number that is not on WhatsApp gets the
   "could not deliver" error (customer only); an owner's number receives a code from the owners' app; a non-owner's number
   gets the identical screen and **no message appears in the MSG91 log**; response times look alike. If owners never receive a
   code, check the Auth logs for a CAPTCHA refusal of the service-role call. Also request a code as a tester from a known
   network and check that `select ip, outcome, created_at from public.owner_login_attempts order by created_at desc limit 5;` shows an
   `ip` that is non-null and equals the tester's real public address. If it is null, the per-IP limit is not running (only
   Cloudflare's `cf-connecting-ip` is trusted): record it as a launch follow-up rather than relying on that limit.

### Production owners

Create each owner with their phone number, then add the membership. In Authentication → Users, **Add user** with the phone and
confirm it, or call `auth.admin.createUser({ phone: '+91XXXXXXXXXX', phone_confirm: true })` from a trusted machine. Supabase stores
the number without the plus sign. Then, from a trusted connection:

```sql
insert into public.business_memberships (business_id, user_id, role, display_name)
select b.id, u.id, 'admin', 'Owner' from public.businesses b, auth.users u
where b.slug = 'ammu-sammu' and u.phone = '919876543210';
```

An owner who already has a customer account on the same number is the same user; adding the membership is all that is needed.

### Rate limits and the security log

`public.claim_owner_code_attempt` (service role only) decides ownership, applies the limits and writes the log in one call, under
advisory locks in the order IP, phone, restaurant (it takes no row locks on users, sessions, accounts or businesses, so the
lifecycle lock order above is unaffected). Limits count admitted requests, owners and non-owners alike: 3 per phone per 15 minutes
and 10 per day, 10 per IP address per hour, and 30 sends per restaurant per hour to cap cost. Refused requests are logged but never
extend a lockout. The only trusted client address is Cloudflare's `cf-connecting-ip`; `x-real-ip` and `x-forwarded-for` are ignored
because a caller can forge them. When no trusted address is present the row's `ip` is NULL and the per-IP limit is skipped (the phone,
restaurant and CAPTCHA limits still apply); verify this on staging as described above.

**Accepted risk: lockout.** A sustained attacker with working CAPTCHA tokens can keep an owner's number refused for *new* sign-ins
for up to a day or more, because the per-phone daily quota refills only as the attacker's own admitted attempts age out. Owners who
are already signed in keep working. Accepted for launch; a follow-up should add a recovery path (for example a trusted override).

**Accepted risk: cooldown oracle.** The identical response is a property of the `request-owner-code` endpoint only. Supabase Auth keeps a
per-user resend timestamp that the endpoint cannot hide: a caller with two CAPTCHA solves can ask the owners' endpoint for a number and
then immediately make the public customer-flow request to Auth for the same number; Auth answers with its "request again after N
seconds" refusal only if a code was just sent, which happens only for an owner. That tells an owner's number apart, and it also
sends a WhatsApp message to the owner (and the customer-flow request itself sends one to any stranger's number, at our cost).
Accepted for launch; the CAPTCHA, the limits above and the project SMS limit are the only mitigations.

**Owner resend cooldown.** An owner who asks again inside Auth's 30-second resend interval is consumed silently (the endpoint still
answers normally), so the owners' screen (50-C) must enforce its own 30-second cooldown between requests.

`public.owner_login_attempts` records phone, restaurant, app, IP address and outcome (`non_owner`, `rate_limited`, `sent_owner`,
`provider_failed`), never a code or token. RLS is on with no policy and no client grant; only developers using the service role or the SQL editor
can read it. It is not in Realtime. Entries older than 90 days are removed by `select public.purge_expired_owner_login_attempts();`,
executable only by `service_role`. **There is no pg_cron installation or schedule in the repository**: the owner arranges regular invocation (daily is enough; runbook step 8 has an optional snippet and a manual fallback) and verifies it before claiming the 90-day retention is live.

Known limit: Supabase Auth's own `signInWithOtp` is public, so someone could request a customer-flow code for an owner's number
directly. It is bounded by CAPTCHA, the 30-second resend interval and the project SMS limit, and it never grants access
(an owner session needs an admin membership), but it is not covered by the table above.

## EAS native builds

Native builds use a separate EAS project per target. The identifiers in `config/app-targets.json` are:

| App | iOS bundle ID and Android package |
| --- | --- |
| `ammu-sammu-customer` | `com.rosepinkdragon.ammusammu.customer` |
| `ammu-sammu-admin` | `com.rosepinkdragon.ammusammu.admin` |
| `kokani-dine-inn-customer` | `com.rosepinkdragon.kokanidineinn.customer` |
| `kokani-dine-inn-admin` | `com.rosepinkdragon.kokanidineinn.admin` |

Create each EAS project and a matching GitHub environment. Add `EXPO_TOKEN` as an environment secret, that project's UUID as the `EAS_PROJECT_ID` environment variable, and `EXPO_OWNER` if needed. The manual workflow maps the ID to `EXPO_PUBLIC_EAS_PROJECT_ID`. Once provider settings and signing credentials are ready, run **Actions → Manual EAS Build**, choosing the app, platform and preview or production profile. No build or store submission starts automatically. Review signing, store metadata, and privacy separately.

Register the four native identifiers with Firebase when native integration is implemented; native push currently requires additional provider integration, development builds, and APNs/FCM setup. Do not commit native provider files or private credentials. See [notification notes](../packages/notifications/README.md).

### Customer relationship foundation (#52, PR A)

Checkout enrolls a never-linked customer in the same transaction under the account lock;
no client join call is required for a first order. A retained `left` marker distinguishes a
completed leave from never linked. Checkout refuses `left` and `leave_pending`, including
replays, without changing the generation. Explicit `services.joinBusiness()` may reactivate
`left` with a fresh generation/timestamp; pending leave still blocks join. PR B must keep
the `left` row and never delete it: auto-enrollment cannot distinguish a deleted relationship
from a never-linked customer. Active replays preserve the existing order, relationship
generation and timestamp. Enrollment is inserted only immediately before a new order,
after all pricing checks. Pricing rejections and both replay paths never insert or change
a relationship. Exceptions roll enrollment back with the order. Corrected pricing retries
use a fresh idempotency key; the original rejected key remains terminal. Existing orders
backfill the earliest customer/business timestamp at baseline bootstrap only; never rerun
backfill after leave becomes available.

`customer_lifecycle_private.accounts` is the durable per-user lock/state row, created
lazily or by backfill and removed only with the Auth account. The full lock order is
**users KEY SHARE → sessions SHARE (where validated) → accounts FOR UPDATE → business
→ advisory checkout key → address/menu/order rows**. `lock_account` takes users KEY SHARE
before touching accounts, and join takes users KEY SHARE before validating/locking the
session. This prevents inversion against Auth deletion cascading through sessions/accounts.
The existing checkout authentication contract is unchanged; join validates the live session.
Account `deletion_pending` blocks both paths. History remains readable through existing RLS.

PR B, only after A merges, supplies the leave request/receipt, last-business and active-order
checks, cleanup and `purge_customer_notifications` call. Its order transitions must share
this account lock before locking orders. It must preserve order snapshots and shared saved
addresses, fence old retries by generation, and document the device-local cart/preferences
cleanup and local sign-out handoff. PR A exposes no leave or pending-state mutation API;
its pending-state tests use trusted fixtures. Admin memberships/tokens are unaffected.

### Leave a restaurant (#52, PR B)

`leaveBusiness({requestId,generation})` calls the public invoker/private definer RPC.
Persist the UUID request ID and relationship generation before sending; retry those same
values after a timeout/lost response. A request ID is scoped to its customer and cannot be
reused for another business/generation. The completed receipt records the original server
cutoff. Replaying it after rejoin returns that receipt without executing cleanup again.
A new request with an old generation is rejected. No implicit rejoin is allowed from leave.

Leave holds users → sessions → accounts → business locks, checks non-final orders and
another active relationship, then atomically marks pending, removes only customer tokens
and pending push jobs for this business, calls `purge_customer_notifications` with the
original cutoff, marks the retained row left, and saves its receipt. Admin tokens and
memberships, other businesses, shared addresses and all order/history snapshots remain.
Completed push audit rows are retained with their removed token reference set null. Token
rows are locked in ID order before jobs. The dispatcher unregistered path also locks the
token first, then rechecks the job/lease, matching registration/rotation/delete cascades.
Failure rolls the entire transaction back, including pending state and cleanup; there is
no externally committed half-finished stage. Concurrent operations wait, then re-check.
Future multi-transaction lifecycle work must preserve the same lock/state/generation rules.

`transition_order` acquires the customer's lifecycle lock before business/order locks.
Thus a non-final transition still blocks leave; a committed final transition is included
in the leave cutoff and feed purge. Customer token registration uses the same lock and
refuses pending/left relationships; admin registration remains independent. Work already
handed to an external push provider cannot be recalled; removing its job invalidates later
lease completion and destination lookup. No external provider or Auth deletion is called.

A receipt confirms server cleanup only. Its `localCleanup` handoff identifies business,
generation and request. Client delivery must clear only that generation's cart/preferences
and use local sign-out after confirmation; never let an old receipt clear a later rejoin.
Local storage cannot be cleared by SQL. This backend slice does not wire screens/device
cleanup, and does not claim those steps or full #52 are complete. Keep the left row forever
until account deletion; only explicit join replaces its generation.
