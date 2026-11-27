# Release setup

This repository does not create provider projects, configure credentials, or deploy the apps. Never commit private credentials or send them in chat. Public client configuration can be entered in Vercel's environment settings. Complete and verify the provider and launch steps below before accepting real orders.

## Web launch runbook (owner)

This is the one ordered checklist for a web-only launch on your own Supabase project and Vercel. Work top to bottom; later steps depend on earlier ones. Agents never deploy, link a Supabase project or run `supabase db push`: you run the commands below from a trusted machine. Detail and rationale for each step is in the sections further down; native builds (EAS) are out of scope here. Anything marked **confirm in dashboard** is not defined by this repository.

Before you start: the customer and owners' WhatsApp sign-in screens (#50 slices B and C) are on `main`; deploy from a `main` commit that includes them, because the apps cannot sign in without them.

**Never run `supabase config push` for this repository.** Configure hosted Auth in the dashboard only. Since #212 the committed `supabase/config.toml` is production-safe by default (no test OTP numbers, CAPTCHA on, the send_sms hook disabled) and the check `npm run check:hosted-auth` runs in App CI (it becomes a required gate once #215, branch protection, is configured), but the dashboard remains the source of truth for hosted Auth: the check cannot see the hosted project. Local fixtures are in the [appendix](#appendix-local-development-fixtures-212).

### 1. Create the Supabase project and push the database

1. In the Supabase dashboard create a new, empty project. Note the project ref, the Project URL (**Connect**) and the publishable (or legacy `anon`) key (**Project Settings → API Keys**). Never use or expose the service-role key in Vercel.
2. From a trusted machine: `supabase login`, then `supabase link --project-ref <project-ref>`. Check the printed ref is the new project and not another one (the two `dukan-dar` projects are unrelated Prisma databases and must never be linked).
3. Run `supabase db push`. On an empty project this applies only `supabase/migrations/20261117000000_baseline.sql` (schema, no data). Do not use `supabase/seed.sql`; it is demonstration data. Unverified CLI behavior: the CLI may complain that `SUPABASE_AUTH_CAPTCHA_SECRET` (or another `env()` value in `supabase/config.toml`) is not set; if so, export a placeholder value for that one command only. `db push` and `functions deploy` do not push Auth config.
4. Create the two businesses and set kitchen points and the 12 km delivery radius with the SQL in [Supabase and launch data](#supabase-and-launch-data), step 5. `order_prefix` cannot be changed afterwards. Leave `ordering_enabled` false until the staging checks in step 9 pass, then enable ordering per business (**confirm in dashboard** or SQL editor; this is the existing owner setting).
5. Migrations are now forward-only: see [Migration policy](#migration-policy-frozen). Any later schema change is a new timestamped file.

### 2. Deploy the Edge Functions

From the same linked machine (if the CLI complains about a missing `env()` value such as `SUPABASE_AUTH_CAPTCHA_SECRET`, export a placeholder for the command only; unverified CLI behavior, and `functions deploy` does not push Auth config):

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
| `EXPO_PUBLIC_FIREBASE_API_KEY`, `_PROJECT_ID`, `_MESSAGING_SENDER_ID`, `_APP_ID`, `_MEASUREMENT_ID`, `_ANALYTICS_STREAM_VERIFIED` | Part of the web launch (step 7a): each app uses its own Firebase web app config. Set `_ANALYTICS_STREAM_VERIFIED=true` only after Enhanced Measurement is confirmed off for that app's stream; until then analytics stays unavailable |
| `EXPO_PUBLIC_FIREBASE_VAPID_KEY` | Not part of the web launch (step 5); leave unset |
| `EXPO_PUBLIC_SENTRY_DSN`, `EXPO_PUBLIC_SENTRY_ENVIRONMENT`, `EXPO_PUBLIC_SENTRY_RELEASE` | Error reports (step 7b). Leave all unset to switch error reports off. `_RELEASE` is optional, for example a short commit id |
| `EXPO_PUBLIC_WEB_BASE_PATH` | Leave blank (or `/`) |

`EXPO_PUBLIC_EAS_PROJECT_ID` is not used for web. Variables are baked in at build time, so redeploy after changing any. Add each project's production domain to the Supabase redirect URLs (step 4) and to the Turnstile widget. You trigger the deploys; agents do not.

### 7a. Firebase analytics and performance (part of the web launch)

Usage analytics (Google Analytics through Firebase) and speed monitoring (Firebase Performance Monitoring) are both part of the web launch. Both are off for every user until they switch on **Share app usage** (the same switch that governs error reports, step 7b); nothing from Firebase loads before that. Push notifications, the VAPID key and `dispatch-notifications` stay out of the launch (step 5).

1. In the Firebase console create one project and register four web apps, one per Vercel project (**Project settings → General → Your apps**). Copy each web app's public config into that Vercel project: `EXPO_PUBLIC_FIREBASE_API_KEY`, `_PROJECT_ID`, `_MESSAGING_SENDER_ID`, `_APP_ID`, and `_MEASUREMENT_ID` (the measurement ID is in the same config once Google Analytics is linked to the project). Firebase client config is public.
2. Enhanced Measurement verification: for each web app open Google Analytics → Admin → Data streams → the web stream and turn **Enhanced Measurement** off, including every automatically collected option. Check that it is off for the actual stream of each of the four apps, and only then set `EXPO_PUBLIC_FIREBASE_ANALYTICS_STREAM_VERIFIED=true` in that app's Vercel project. The code cannot see this console setting; leave the flag `false` until you have verified it.
3. Performance Monitoring needs no extra environment variable: it uses the same Firebase config, and the first time it is used in the project the console asks you to enable it (**Release & Monitor → Performance**, **confirm in dashboard**). Page-load and network-request traces (Supabase REST, Auth and Edge Function calls) are automatic. The custom traces are `checkout_submit`, `otp_request`, `otp_verify` and `photo_upload`; they carry a name and timing only.
4. Redeploy each project (variables are baked in at build time). Then, on a deployed domain, sign in, switch on **Share app usage** in Account (customers) or Settings (owners) and use the app. Analytics events `menu_view`, `ordering_started` and `order_completed` carry only the brand and audience. Confirm them in Google Analytics → Admin → DebugView or Reports → Realtime, and the traces in the Performance dashboard (data can take some minutes to appear).
5. Because the switch is per signed-in account, only signed-in customers and owners who have opted in are measured. The first page after consent may be only partly timed, and traces for the sign-in screens (`otp_request`, `otp_verify`) are recorded only if the person was already opted in.

### 7b. Sentry error reports (part of the web launch)

Sentry records uncaught errors, unhandled promise rejections and screens that fail to render, only for people who switched on **Share app usage** and only when a DSN is set. It sends no session replay, request bodies, cookies or user identity, and the app removes URL query strings and phone numbers, emails and 4 to 8 digit codes from reports before they leave the browser.

1. In Sentry (free plan is enough) create one project with the **Browser JavaScript** platform. Copy its DSN (**Settings → Client Keys (DSN)**). A DSN is public client configuration.
2. Set `EXPO_PUBLIC_SENTRY_DSN` to that DSN in all four Vercel projects. Set `EXPO_PUBLIC_SENTRY_ENVIRONMENT` to `production` (and something else such as `preview` for Preview deployments). Optionally set `EXPO_PUBLIC_SENTRY_RELEASE` (for example a short commit id) so errors can be tied to a deploy. Leaving the DSN unset switches error reports off.
3. In the Sentry project settings turn **Data Scrubbing** on (**Settings → Security & Privacy**: Data Scrubber and Use Default Scrubbers on), and turn **Prevent Storing of IP Addresses** on if your plan allows it (**confirm in dashboard**). This is a second line of defence behind the app's own scrubbing.
4. Redeploy, switch on **Share app usage** on a deployed domain, and trigger a test error. Confirm the event arrives and contains no phone number, email, code or query string.
5. Withdrawal: switching the setting off closes the Sentry client; no further reports are sent.

### 7c. Where to watch server-side speed and errors (Supabase)

Firebase Performance shows what the browser experienced. For the server side, in the Supabase dashboard:

- **Reports** (left menu): the **API** report shows request volume, response times and error rates for REST and Auth; the **Database** report shows load and slow queries; **Edge Functions** reports invocations, errors and execution time for `request-owner-code`, `send-sms-hook` and `menu-photos`.
- **Logs** (left menu): **API Gateway** and **Postgres** logs for failing requests (filter on status 4xx/5xx), **Edge Functions** logs per function (**Edge Functions → the function → Logs**) for what a function printed, and **Auth** logs for sign-in problems.

Report names can differ by plan and dashboard version (**confirm in dashboard**). Check them on launch day after the first real orders.

### 8. Purges (retention)

The baseline has exactly two purge functions, both callable only by `service_role` (and by `postgres` in the SQL editor), and nothing schedules them:

- `public.purge_expired_owner_login_attempts()` removes `owner_login_attempts` rows older than 90 days.
- `public.purge_expired_customer_notifications()` removes customer notification feed rows older than 30 days (reads already hide them).

`public.purge_customer_notifications(...)` is internal to the leave-restaurant flow; do not schedule it.

Account deletion (#51) adds a third trusted purge: `public.purge_deleted_customer_order_snapshots()` blanks customer details on orders of deleted accounts once the retention period (a setting, default 365 days) has passed. Its schedule and setting are in [Customer account deletion](#customer-account-deletion-51-slice-1-database-and-services).

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
5a. One-time manual verification of the hosted project's Auth settings (#212; evidence goes to #64 hosted provider setup and the #15 release gate; not done yet because no hosted project exists): in the dashboard confirm there are **no test OTP numbers** (Authentication → Providers → Phone), **CAPTCHA is on** with the real Turnstile secret, the send_sms hook points at the project's own `send-sms-hook` function, and the Site URL and redirect URLs are the intended production domains only (https, no localhost). Record who checked, when and the project ref.
6. Place an order end to end on each brand (Ammu Sammu and Kokani Dine Inn): sign in, add to cart, checkout inside the delivery area, see it in that brand's admin app, move it through the order statuses. Confirm an address outside 12 km is refused.
7. Inspect `/firebase-messaging-worker.js` on each domain for the revalidating `Cache-Control` header.
8. For each brand, an owner uploads a dish photo in the owners' app and it appears on the customer menu.
9. Analytics, speed and error reports (steps 7a to 7c): with **Share app usage** off, the browser network tab shows no request to Google, Firebase or Sentry; with it on, a signed-in test account's events, traces and a test error reach the three dashboards.
9a. On each of the four deployed sites, open DevTools, enable **Preserve log** in Console and Network, and reload. Confirm the document response has the `Content-Security-Policy` header and the Console reports no CSP violations while doing the following:
   - Sign in through Turnstile on both customer sites and both owner sites.
   - On each customer site, allow location at checkout and confirm the browser supplies a location. Check that menu photos load on the customer sites and dish photo previews load on the owner sites.
   - After opting in to **Share app usage** on each site, confirm analytics, performance and a test error send successfully. On deployments with web push enabled, also grant notification permission, confirm the worker registers and receive a test notification.
10. Then enable `ordering_enabled` for each business and report the live URLs only after this browser verification.

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

A repository administrator should open GitHub **Settings → Branches** (branch protection rules) or **Settings → Rules → Rulesets** and protect `main`: require pull requests, require passing checks (`Delivery policy`, `policy` and `ci`; `ci` is the one always-running App CI check that passes when jobs were skipped as unneeded and fails if any needed job failed, so the individual `quality`, `export`, `build`, `suites`, `postgis-rls` and `dispatcher` jobs need not be listed), require branches to be up to date before merging, and disallow force pushes. Select the intended check sources where available and consult [the repository workflow](WORKFLOW.md) for enforcement limits and review policy. These protections are account settings and are not established by this repository.

A formal GitHub approval requires a distinct eligible reviewer; agent review reports or PR comments are not GitHub approvals, and the PR author cannot approve their own PR. Arrange an eligible reviewer before requiring formal approval or CODEOWNERS review so the rule is workable.

## Supabase and launch data

1. Create one Supabase project for the intended environment. In the dashboard, use **Connect** for the Project URL and **Project Settings → API Keys** for the publishable key (the legacy `anon` key also works). Set `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_ANON_KEY` in all four Vercel projects. These are public client values; never expose the service-role key.
2. From a trusted machine, authenticate the Supabase CLI, link the intended project with `supabase link --project-ref <project-ref>`, review the target and migrations, then run `supabase db push`. On a fresh project this applies the single baseline, `supabase/migrations/20261117000000_baseline.sql`. It creates the schema and no data: no restaurant, menu, kitchen point or delivery area rows. Both businesses share this database; verify row-level security and cross-business isolation with appropriate accounts. `supabase/seed.sql` is demonstration data, not a production catalog or verified boundary; don't use it as launch data. Keep business and menu `is_demo` flags consistent with real, reviewed data. (If the CLI complains that `SUPABASE_AUTH_CAPTCHA_SECRET` or another `env()` value is missing, export a placeholder for that command only; unverified CLI behavior, and this command does not push Auth config.)
3. Configure **Supabase Auth** and its implemented sign-in method. In Authentication → URL Configuration, add the four exact production domain roots to Redirect URLs; add only current trusted preview roots if previews need authentication. A separate staging project is preferable for previews. Set the Site URL appropriately and verify sign-in and callback on each app. Avoid broad preview wildcards.
4. Through a trusted administrative database setup, create the appropriate `business_memberships` for authenticated admin users and verify each admin can access only their business. Do not distribute service credentials to clients.
5. Create the real launch restaurant rows, then confirm each business's delivery area before enabling ordering. A fresh project has no restaurant rows, so checkout fails closed until trusted setup supplies them. From a trusted administrative connection (the Supabase SQL editor runs as `postgres`), insert the minimal rows. Only `slug`, `name` and `order_prefix` have no default; `is_demo`, `ordering_enabled` and `accepting_orders` default to false and `id` is generated:

```sql
insert into public.businesses (slug, name, order_prefix, is_demo) values
  ('ammu-sammu', 'Ammu Sammu', 'AMS', false),
  ('kokani-dine-inn', 'Kokani Dine Inn', 'KDI', false);
-- Opening hours (#253), India time; 00:00 as the closing time is midnight. The migration sets these only for rows that
-- already exist when it runs, so on a fresh project run them after the insert above (owners edit them later).
update public.businesses set opens_at = time '11:00', closes_at = time '00:00' where slug = 'kokani-dine-inn' and opens_at is null;
update public.businesses set opens_at = time '09:00', closes_at = time '19:30' where slug = 'ammu-sammu' and opens_at is null;
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
| `frozen` (current) | Baseline applied or about to be applied to a persistent environment. Forward-only. | Fails when a PR modifies, deletes or renames an existing migration file, including the baseline. A new file must sit directly under the exact lowercase `supabase/migrations/` prefix (nested paths and other casings are rejected) and be named `<14-digit timestamp>_<name>.sql` (lowercase letters, digits, underscores). The timestamp must be a real UTC calendar date and time (month 13, day 32 or hour 99 is rejected), after the baseline version, and no more than one year ahead. The trusted check also verifies, through the GitHub API at the PR head, that `supabase/migrations/<baseline.version>_*.sql` exists and that `baseline.commit` exists and is an ancestor of the head (no checkout depth involved). No override. |

Repairing a bad policy: once frozen, a missing or malformed `baseline.version` or `baseline.commit` on `main` makes the trusted check fail for every PR, including the PR that would repair it. This is fail-closed by design, so the repair needs an owner/admin path, for example a direct fix on `main` by the repository owner.

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
2. For analytics, find the web app's measurement ID in its Firebase web config or Google Analytics → Admin → Data streams → the web stream, and set `EXPO_PUBLIC_FIREBASE_MEASUREMENT_ID`. In that same stream turn **Enhanced Measurement** off, verify it is off for the actual stream, and only then set `EXPO_PUBLIC_FIREBASE_ANALYTICS_STREAM_VERIFIED=true`. Leave it false until verified. Analytics, Performance Monitoring and Sentry error reports all require user consent through the same switch.
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
   Auth (as it is in the local overlay `supabase/config.local.toml`, not in the committed config) or every code request is refused.

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
   off in `supabase/config.toml`; each authenticates itself). If the CLI complains that `SUPABASE_AUTH_CAPTCHA_SECRET` or another
   `env()` value is missing, export a placeholder for that command only (unverified CLI behavior; this command does not push Auth config).
2. Authentication → **Hooks** → Send SMS: HTTPS, the URL of `send-sms-hook`, generate the secret, and store it as `SEND_SMS_HOOK_SECRET`.
   **Enable the hook and store the secret in the same sitting**: a hook that is enabled before the function has its secret (or a secret
   that no longer matches) makes every code request fail. Auth signs every call (Standard Webhooks) and the function rejects anything unsigned or older than five minutes.
3. Authentication → Providers → **Phone**: enable it. No SMS provider is needed with the hook. Set **SMS OTP expiry to 600**
   seconds (10 minutes; the default is far longer), length 6, and the resend interval (minimum time between codes, `max_frequency`) to **30 seconds**, the cooldown the screens show by default. Leave the project SMS rate
   limit modest (`auth.rate_limit.sms_sent`); it also caps WhatsApp spend on the customer path.
4. Authentication → **Bot and Abuse Protection**: enable CAPTCHA with Turnstile and the same secret (only together with
   `EXPO_PUBLIC_TURNSTILE_SITE_KEY`, see provider setup step 4). The customer screens send a token with each code request. Auth skips its own CAPTCHA check for the service-role call that `request-owner-code`
   makes, because that function has already verified the token itself.
5. `supabase/config.toml` carries the same settings in a production-safe form (OTP expiry 600, resend interval 30 seconds, CAPTCHA on with
   `env(SUPABASE_AUTH_CAPTCHA_SECRET)`, no test numbers, the send_sms hook disabled). The local-only values (two fictional test numbers that skip the hook
   and accept `123456`, CAPTCHA off, the local hook address) are in `supabase/config.local.toml` and reach only a generated, git-ignored local
   workdir. **Never run `supabase config push` for this repository** and configure hosted Auth in the dashboard only. For local functions, put
   `OWNER_CODE_CAPTCHA=off` (or a Turnstile test secret) in the untracked env file.
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

Active sessions (#213): the checkout, order, owner and notification-marker RPCs call `customer_lifecycle_private.require_active_session`
(first lock in the order above). Direct writes through RLS (menu items and categories, offers, saved addresses, the notification read
marker) use `session_rls_private.require_active_session()` in their policies instead. It is a STABLE lookup that takes no lock, so it adds
nothing to the lock order. Both raise 42501 `invalid session` with detail `INVALID_SESSION`; the services map it to `SIGN_IN_REQUIRED`.

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

## Customer profile (#45, slice 1: database and services)

Added by the forward-only migration `20261126150000_customer_profiles.sql`; the baseline is untouched. `public.profiles` holds one
`full_name` per Auth account (primary key `user_id`, `ON DELETE CASCADE`), shared by both restaurant apps; phone comes from Auth and orders keep
their own name/phone snapshots. `full_name` is trimmed, 1 to 120 characters (CHECK), matching `place_order` and the shared TypeScript validator.

- Access: RLS on (not forced, like the rest of the schema). Authenticated users have own-row SELECT, INSERT and UPDATE policies
  (`user_id = auth.uid()`); INSERT and UPDATE also require an active Auth session (`session_rls_private.require_active_session()`, #213 slice B).
  There is no DELETE grant or policy. anon has no privilege. Restaurant owners, admins and members have no policy: they see no profile.
- Writes are column-granted: clients may set `full_name` only. `user_id` defaults to `auth.uid()` (so PostgREST's `on_conflict=user_id` upsert
  never names a user), and a trigger refuses any change of `user_id` and maintains `created_at`/`updated_at`.
- Initialization: no backfill and no row at sign-up. No name is stored server-side today, so a profile is created on its first save and a missing
  row means "no name yet". Never derive one from `user_metadata` or an order's `customer_name`.
- Lock order: unchanged. The table takes no advisory or lifecycle lock; the only interaction is the FK to `auth.users` (KEY SHARE, first in the order)
  and its cascade.
- Services: `getProfile()` (null before the first save) and `saveProfile({ fullName })` for the signed-in customer; stale results after sign-out, an
  account switch or disposal are refused with `SESSION_CHANGED`. Errors: `PROFILE_INVALID_NAME`, `SIGN_IN_REQUIRED`, `PROFILE_REQUEST_FAILED`.
  No UI uses them yet (slice 2).

## Checkout budget support (#216)

Use the SQL editor or the service role only after verifying the owner's request and that the order belongs to their restaurant. Use the internal customer ID from that order. `public.manage_order_budget(slug, customer_id)` returns the current `used`, `limit` and last `reset_at` values for that customer and restaurant. Pass `true` as the third argument to reset the budget.

```sql
select public.manage_order_budget('ammu-sammu', '<customer-uuid>'::uuid);
select public.manage_order_budget('ammu-sammu', '<customer-uuid>'::uuid, true);
```

The 20-order rolling window counts cancelled orders. A reset starts a fresh budget for that customer and restaurant and preserves orders and replay keys. Resetting an account while deletion is pending returns SQLSTATE `PT409` with detail `ACCOUNT_LIFECYCLE_PENDING`. Create live orders through checkout so the order time is recorded under the same account lock as the reset. The budget uses the recorded order time for privileged imports. New checkout snapshots store the recipient phone as `+91` plus ten digits. Existing order snapshots keep their original format.

## Customer account deletion (#51, slice 1: database and services)

Added by the forward-only migration `20261126210000_account_deletion.sql` (it must sort after every migration on `main`, including `20261126200000_opening_hours.sql`). Database and services only: no screens, no web page (slice 2); the Edge Function that removes Auth users is described below. Nothing here touches a remote project.

**What `public.request_account_deletion()` does** (customers only; invoker wrapper over a private SECURITY DEFINER function, `search_path=''`; one transaction, so it either does everything or nothing). Lock order: users KEY SHARE, sessions SHARE (the active-session check), the account row FOR UPDATE, then each owned restaurant FOR NO KEY UPDATE in id order (the same per-restaurant owner lock #59 reuses), then token, order and other rows. `place_order`, `join_business`, `leave_business`, token registration and `transition_order` take the same account lock, so an order cannot slip in while deletion starts.

- Refused, changing nothing: a dead session (`INVALID_SESSION`), an order that is not delivered or cancelled (`PT409`, `ACCOUNT_HAS_ACTIVE_ORDER`), and being the only usable owner of any restaurant (`PT409`, `ONLY_OWNER`). A co-owner whose own account is already pending does not count as another owner.
- Removed at once: profile, saved addresses, device tokens and their pending push jobs (completed audit rows keep a null token reference), customer notifications (`purge_customer_notifications`), restaurant relationships, leave requests, offer code attempts, pricing-rejection replay rows, the owner membership, and the owner's name on past order history ("Former owner"; `changed_by` set null).
- Kept for the restaurants: orders with their items and history, and offer redemptions, all with `customer_id` null. `orders.customer_id`, `offer_redemptions.customer_id` and `order_status_history.changed_by` are now `ON DELETE SET NULL`, so even a direct `delete from auth.users` no longer fails. Owners still see these orders (the RLS policy tests `customer_id = auth.uid()`, which is never true for null); no customer does.
- The account is marked `deletion_pending` with `deletion_requested_at`. A pending account is refused by checkout, join, leave, token registration and every RLS write behind the active-session helper (`PT409`, `ACCOUNT_LIFECYCLE_PENDING`), so signing in again with the same phone cannot recreate a profile, address or order. Calling it again returns the same confirmation and changes nothing.

**Auth user removal (the one step SQL cannot do).** SQL cannot call GoTrue's admin API, and whether the SECURITY DEFINER owner may delete from `auth.users` on a hosted project cannot be shown by local tests (they run as superuser). So the RPC leaves the `auth.users` row and the trusted `finish-account-deletions` Edge Function removes it (next section). `public.list_accounts_pending_auth_deletion(limit)` (service_role only) lists who is waiting, oldest first. Removing the user cascades the leftover account row and sessions and signs the person out everywhere; their orders stay, unlinked. The person is already unable to do anything while pending. **Manual fallback** (function not deployed, or it keeps failing): remove each listed user from the dashboard (Authentication, Users, Delete user) or with `auth.admin.deleteUser` and the service-role key from a trusted machine, after running `select public.prepare_account_auth_deletion('<id>');` in the SQL editor (the final cleanup; it answers `pending`) and afterwards `select public.complete_account_auth_deletion('<id>', null);` (records the completion; it answers `true`). **Before the first real deploy, confirm** that the admin delete succeeds for a user who has orders (it should, because of `SET NULL`), and that `FOR KEY SHARE` on `auth.users` works for the definer owner (see the #51 comments).

### Finish account deletions (Edge Function, #51 slice 2a)

Migration `20261126220000_finish_account_deletions.sql` adds two service_role-only RPCs and a private completion table; the function is `supabase/functions/finish-account-deletions` ([notes](../supabase/functions/finish-account-deletions/README.md)). Nothing is deployed or scheduled by the repository.

1. **Secret.** Generate at least 32 random characters on a trusted machine and store them as a function secret: `supabase secrets set FINISH_ACCOUNT_DELETIONS_SECRET=<value>`. Never put it in chat, GitHub or a frontend variable. Use the exact value in Vault and in the function secret. The function reads it at startup, so redeploy after rotation. A trailing newline changes the value and causes HTTP 401 responses. `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are provided to the function by Supabase. Optional: `FINISH_ACCOUNT_DELETIONS_BATCH` (accounts per page, 1 to 50, default 20).
2. **Deploy** after the migration is applied: `supabase functions deploy finish-account-deletions` (JWT verification is off in `config.toml`; the handler checks the secret first and answers 401 to anything else, including when the secret is missing or short).
3. **Schedule** it daily using pg_cron and pg_net or any trusted scheduler. The pg_cron schedule below runs at 03:47 UTC. Enable the extensions and store the secret in Vault so it is absent from the job text. Replace both placeholders before running the snippet. Avoid saving any query containing the real `vault.create_secret` call in SQL Editor history or saved queries. If the editor retains query text, run that statement from a trusted SQL client with history disabled.

   ```sql
   create extension if not exists pg_cron;
   create extension if not exists pg_net;
   create extension if not exists supabase_vault with schema vault;

   select vault.create_secret('<same function secret>', 'finish_account_deletions_secret');

   select cron.schedule('finish-account-deletions', '47 3 * * *', $job$
     select net.http_post(
       url := 'https://<project-ref>.supabase.co/functions/v1/finish-account-deletions',
       headers := jsonb_build_object(
         'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'finish_account_deletions_secret')
       ),
       timeout_milliseconds := 120000
     );
   $job$);
   ```

   Confirm the HTTP response in pg_net or Edge Function logs. A successful cron run only confirms the request was queued. An account already in progress can finish after the 120-second HTTP timeout. Raising the finisher's time budget in code above 120 seconds makes overrunning the pg_net timeout more likely. A manual run sends the same POST with the same Authorization header.

   **Rotation.** Between scheduled runs, update Vault first. Use a trusted SQL client with history disabled for the new value.

   ```sql
   select vault.update_secret(id, '<new function secret>')
   from vault.secrets
   where name = 'finish_account_deletions_secret';
   ```

   Then set `FINISH_ACCOUNT_DELETIONS_SECRET` to the same new value and redeploy the Edge Function. Confirm the next POST succeeds.
4. **What a run does.** For each pending account, oldest first, in pages of 20. After five pages or 100 seconds it starts no further accounts. The account already in progress can finish beyond that deadline, and a later run resumes any remaining work. For each account, `prepare_account_auth_deletion` repeats the active-data cleanup under the account lock and refuses an account that is not pending; then the Auth admin API deletes the user (a 404 means already gone and counts as done); then `complete_account_auth_deletion` confirms the `auth.users` row is gone and records the completion (`customer_lifecycle_private.account_deletion_completions`: the random account id and two timestamps, no personal data). Everything is idempotent, so a lost response or a rerun is safe. A failure on one account is counted and the others continue. The answer is JSON counts only (`listed`, `deleted`, `already_gone`, `skipped`, `failed`, `complete`): status 200, 500 when any account failed, 503 when the list could not be read. Logs hold fixed words only, never ids, phone numbers or tokens.
5. **Daily check.** Both of these should stay empty or recent: `select count(*), min(requested_at) from public.list_accounts_pending_auth_deletion(1000);` (alert when the oldest is more than two days old) and the function's logs (Edge Functions, Logs) for `failed`. Completions: `select count(*), max(completed_at) from customer_lifecycle_private.account_deletion_completions;`. A future status endpoint must authorize access to the request identifier before checking the completion record.

**Late writes and the finisher.** The RLS active-session helper takes no lock, so a profile, address or relationship written at the very moment of deletion can land after the first pass and survive on the pending account. Calling `request_account_deletion()` again removes it (the repeat call re-runs the cleanup), and the trusted finisher (the Edge Function, through `prepare_account_auth_deletion`) repeats the same cleanup immediately before deleting the Auth user. The Auth user's removal also cascades `profiles`, `customer_addresses` and the other user-keyed tables.

**Data that outlives the request until the Auth user is removed or purged.** The Auth system tables (identities with the phone, sessions, audit log entries) still hold the person until the Auth user is deleted, and `owner_login_attempts.phone` keeps a number for up to 90 days (section 8 purge). Run the finisher promptly and set an SLA or an alert on accounts that stay in `list_accounts_pending_auth_deletion()` for more than a day or two (for example a daily check that the list is empty or its oldest `requested_at` is recent).

**Retention (placeholder pending the lawyer, #195; DPDP Rule 8(3)).** When the link is cut (by the RPC or by the foreign key action) a trigger stamps `orders.customer_deleted_at`; the retention clock runs from that stamp, per order. `public.purge_deleted_customer_order_snapshots()` (service_role and the SQL editor only; returns the number purged) blanks the name, phone, address line and parts, saved-address reference, latitude, longitude and both distances of orders that are delivered or cancelled and whose stamp is older than the period, once (an order still in progress is never purged, however old, so a customer removed by a direct Auth delete cannot lose details the owner still needs; the owner can finish such an order, and `record_customer_notification` skips the feed row when there is no customer), and stamps `customer_pii_purged_at`. Amounts, items, status, order number and times stay. CHECK constraints keep those fields required for every order that is not purged, and require them blank on a purged one.

- The period is one row: `customer_lifecycle_private.retention_settings.order_snapshot_retention`, default `365 days`, read at purge time, so changing it needs no code or migration. Change it in the SQL editor: `update customer_lifecycle_private.retention_settings set order_snapshot_retention = interval '540 days';` (it must be at least 1 day). A longer period holds orders back; a shorter one makes older ones due on the next run.
- Schedule it like the other purges in section 8 (nothing is scheduled by this change, so retention is not live until you do): `select cron.schedule('purge-deleted-customer-order-snapshots', '37 3 * * *', $$select public.purge_deleted_customer_order_snapshots()$$);` or run `select public.purge_deleted_customer_order_snapshots();` in the SQL editor now and then.
- The issue's "scrub immediately and keep permanently" plan was replaced by the owner's 26 Nov decision. The lawyer must still confirm which fields fall under rule 8(3), and what GST and income-tax record keeping needs; both the period and the field list live in one place each (the setting and the function).

**Services:** `requestAccountDeletion()` returns `{ customerId, state: 'deletion_pending', requestedAtISO }`. Errors: `ACCOUNT_HAS_ACTIVE_ORDER`, `ONLY_OWNER`, `SIGN_IN_REQUIRED`, `SESSION_CHANGED`, `CUSTOMER_REQUIRED`, `INVALID_RESPONSE`, `ACCOUNT_DELETION_FAILED`. A success only means the server finished: the screen must then sign out and clear device-local data (cart, preferences) itself. Retrying after a lost response is safe. Because the whole deletion is one transaction there are no half-finished stages to resume; the only later stage (removing the Auth user) is retried by listing what is still pending.

## Offers and discounts (#182, slice A: database and pricing)

Added by the forward-only migration `20261120070000_offers_and_pricing.sql`; the baseline is untouched. This slice is the
database and the services only: no owner or customer screens (slices B and C), and no dish-level offers (slice D, which also
widens the `kind` check). Nothing here is applied to a remote project by agents.

- `public.offers` (per restaurant) holds order-level offers: `percent` (1 to 90), `flat` (Rs 1 to Rs 1,000) and `free_delivery`,
  `automatic` or by `code`. Owners (admin members) manage their own restaurant's rows through RLS; nobody else has table access.
  Once an offer has been redeemed its terms are locked by a trigger (name, end date and `paused` stay editable). Offers are never deleted: owners pause, resume or end them, and clients have no DELETE grant or policy.
  A code is stored upper case and is unique among the restaurant's not-ended offers. Daily windows are evaluated in Asia/Kolkata.
- Customers never list codes. `public.list_active_offers(slug)` (also for signed-out visitors) returns active automatic offers only,
  with no code, limit or count. `public.check_offer_code(slug, code)` checks one code. `public.quote_order(slug, items, code)` returns the
  server's quote (there was no server-side quote before; the client built one and `place_order` compared it). `public.place_order`
  gained an optional `p_offer_code`; the six-argument form remains for clients built before offers.
- One order-level offer per order: a valid code if sent (never silently replaced), else the best eligible automatic offer (largest
  discount; ties go to the earliest created, then the lowest id). Minimums are checked against the pre-discount subtotal. Uses count
  only non-cancelled orders (`offer_redemptions` joined to `orders`), so cancelling an order gives its use back with no extra code.
- The quote has exactly its old keys when no offer applies. With an offer it adds `discount_paise` and `offer` (`id`, `name`, `code`,
  `kind`); `orders.total_paise = subtotal_paise + delivery_fee_paise - discount_paise` and the order keeps the offer snapshot. An offer
  that stops applying between quote and place returns the outcome `offer_changed` (with a `reason` and the new `pricing`) and the key is
  terminal, like `pricing_changed`; replays return the stored order. A malformed offer id in the accepted pricing is just reason `changed`.
  When the code lookup at place time is rate limited, the outcome is `offer_changed` with reason `rate_limited` and `retry_after_seconds`;
  the wait is stored with the rejection so a replay returns it unchanged, the key stays terminal (retry after the wait with a fresh key),
  and the services raise `OFFER_RATE_LIMITED` (with `retryAfterSeconds` and the repriced cart) rather than `OFFER_CHANGED`. The request hash includes the normalised code only when one is sent.
- Code lookups are rate limited per customer: 10 rejected lookups in 10 minutes (`offers_private.code_attempts`; only rejected lookups
  are logged, so lookups that find an applicable code are not counted; limited lookups are not logged either, so they never extend the wait). `check_offer_code`, `quote_order` and
  `place_order` all use the same limit, so none of them can be used to guess codes.
- Lock order, extending the checkout order above: **users KEY SHARE, sessions SHARE, accounts FOR UPDATE, business SHARE, advisory
  checkout key, advisory code-attempt key (customer; only when a code is sent), advisory offer keys in ascending id order, then
  address/menu/order rows**. Without a code, every not-ended automatic offer of the restaurant is locked and only those are considered.
  The account lock already serialises one customer's orders (per-customer limits and first order only); the offer locks cover the total
  limit across customers. `quote_order` and `check_offer_code` take only the code-attempt key. Cancelling takes no offer lock.
  An owner's UPDATE of an offer takes the same offer key inside the trigger (before it checks for redemptions), so the edit lock
  cannot be beaten by a first redemption in flight: the edit waits for the open checkout, then sees the redemption and is refused. For a
  single-offer UPDATE it holds only that key and the offer row lock, and checkout's foreign keys take KEY SHARE, which that lock does not
  conflict with, so they cannot form a cycle. That claim is for UPDATE only: a statement that edits several offers locks their keys in
  scan order, so either side of a bulk UPDATE racing a checkout can be chosen as the deadlock victim (SQLSTATE 40P01). Slice B must edit one
  offer per statement. Offers are never deleted (there is no DELETE grant, policy or trigger): a DELETE locks the row FOR UPDATE before any
  trigger runs, which conflicts with checkout's KEY SHARE and made the checkout a deadlock victim.
- `orders.offer_id` is a composite foreign key `(business_id, offer_id)` to `offers (business_id, id)`, so an order can only name an offer
  of its own restaurant.
- Offer tables are not in any Realtime publication. `tests/database/offers.sql` and `offers-races.sh` cover the above.

### Offers, owners' app (#182, slice B)

Screens and services, plus one later migration: no customer screens, no dish-level offers. Owners reach **Offers** from Settings.

- `listOffers` reads the restaurant's `offers`, then usage in one call to `offer_usage_stats` (migration `20261125000000_offer_usage_stats.sql`, #186):
  a security-invoker aggregate per offer, so RLS still means only an owner sees any rows, backed by the index `offer_redemptions (business_id, offer_id)`. Uses and
  "given" count non-cancelled orders only. Terms are shown locked once ANY redemption exists, even on a since-cancelled order, because that is what the
  trigger locks on. Status is derived as ended, used up, paused, scheduled, active, in that order.
- Writes (`createOffer`, `updateOffer`, `pauseOffer`, `resumeOffer`, `endOffer`) each touch exactly one offer per statement, are guarded by `version = expectedVersion`
  (no row back is `OFFER_STALE`, or `OFFER_MISSING` if the offer is gone), and retry once on 40P01 or 40001. There is no delete method; DELETE is revoked.
- Error codes: a check violation becomes an `OfferValidationError` with the field named by the constraint; PT409 `OFFER_LOCKED` is `OFFER_LOCKED`; 23505 is `OFFER_CODE_TAKEN`.
- Ending sends `ends_at = 'now'`, so the database clock decides, not the phone's. An offer that has not started also has its start cleared, since an end cannot precede it.
- Times are typed and shown in India time (`YYYY-MM-DD HH:MM`). `tests/browser/owner-offers182.mjs` runs in the `inbox-leave` shard.

### Offers, customer cart (#182, slice C)

- Signed in, the cart is priced by the server: `quote_order` (debounced) supplies the discount, offer and nudge, and `capturePricing` copies the server's `discount_paise` and `offer` into the accepted pricing. Without them `place_order` answers `pricing_changed` for every cart an automatic offer applies to.
- A refused code is dropped and never re-sent (each rejected lookup counts toward 10 per 10 minutes). The saved attempt keeps the code, so recovery replays the same request. `OFFER_CHANGED` / `OFFER_RATE_LIMITED` release the spent attempt, show the reason and repriced total, and wait for another tap on Place order.
- Signed-out visitors see the active automatic offer on the menu and in the cart ("Sign in to apply"); there is no code entry. Order receipts and the owners' order details show the discount; "Collect in cash" is the discounted `total_paise`.

## Opening hours (#253, slice 1: database and services)

No screens in this slice; one migration (`20261126200000_opening_hours.sql`), services and core helpers.

- `businesses.opens_at` and `closes_at` are `time(0)` in India time (Asia/Kolkata), whole minutes, one window per day. Both null means no hours (open all day), which is also what the seed and every fresh restaurant row has until set. The window is `[opens_at, closes_at)`: opening inclusive, closing exclusive. `closes_at = 00:00` means midnight at the end of the day (Kokani Dine Inn is 11:00 to 00:00); `24:00` is never stored (the owner RPC turns it into 00:00; the check rejects it). The check also rejects half a window, an empty window (`opens_at = closes_at`) and a window that crosses midnight into the next day.
- The migration sets Kokani Dine Inn 11:00 to 00:00 and Ammu Sammu 09:00 to 19:30 only where both columns are null and the row exists; for a fresh project see the SQL in [Supabase and launch data](#supabase-and-launch-data), step 5.
- `public.business_open_at(opens, closes, at)` is the pure window test; `public.business_open_now(business_id, at default now())` reads the business (unknown means closed). Both are readable by guests.
- Enforcement is `offers_private.price_items`, which `quote_order` and `place_order` both call. `place_order` reaches it only after its replay and stored-rejection lookups, so an order already placed still replays outside hours, and the owner's switch (`accepting_orders`, #58) is checked first. Outside hours it raises SQLSTATE `PT409` (HTTP 409, like the switch) with DETAIL `OUTSIDE_HOURS` and HINT the opening time as `HH:MM`; nothing is written and the idempotency key is not consumed. Services raise `OutsideHoursError` (code `NOT_ACCEPTING_ORDERS`, `reason: 'OUTSIDE_HOURS'`, `opensAt`, `opensAtLabel`) from both `quoteOrder` and `placeOrder`.
- Owners edit hours with `public.save_opening_hours(slug, opens, closes, expected_version)` (services: `saveOpeningHours`), a separate RPC so `save_restaurant_settings` keeps its signature. It uses the same checks and lock order as `save_restaurant_settings` (users KEY SHARE, sessions SHARE through `require_active_session`, the business row FOR NO KEY UPDATE, the owner's membership FOR SHARE), the same `settings_version`, and the version trigger now also fires on `opens_at` and `closes_at`, so an open settings form and an open hours form each go stale when the other saves (`SETTINGS_CHANGED`). Both null clears the hours. Checkout holds the business row FOR SHARE, so a checkout in flight finishes before an edit lands. No new lock.
- `tests/database/opening-hours.sql` runs last in the shared-fixture chain. The transaction clock cannot be faked, so boundaries are proven on `business_open_at` with explicit instants and enforcement with windows built around the current India time (checked for every minute of the day).

## Appendix: local development fixtures (#212)

The committed `supabase/config.toml` is what any tool reading this repository sees, so it carries only production-safe values. Local fixtures
live in `supabase/config.local.toml`: test numbers `919999900001` and `919999900002` that accept `123456` and skip the hook, CAPTCHA off, and the
send_sms hook enabled at `host.docker.internal`. To run the local stack with them:

1. Put `SUPABASE_AUTH_HOOK_SEND_SMS_SECRET=v1,whsec_<base64>` in `supabase/.env.local` (git-ignored). Pass the same value as `SEND_SMS_HOOK_SECRET` to `supabase functions serve --env-file`.
2. `npm run supabase:local-config` merges the overlay over the committed file into `.supabase-local/supabase/config.toml` (git-ignored, with a "GENERATED, LOCAL ONLY" header) and links `migrations`, `functions`, `seed.sql` and `.env.local` beside it.
3. `supabase start --workdir .supabase-local` (confirm your CLI supports `--workdir` with `supabase start --help`; unverified here, and CI does not run the CLI).

Never link or push the generated workdir. `npm run check:hosted-auth` runs in App CI and fails if the committed config: has entries in
`[auth.sms.test_otp]`; does not enable CAPTCHA with `env(SUPABASE_AUTH_CAPTCHA_SECRET)`; enables any `[auth.hook.*]` (the send_sms hook must be
`enabled = false`); sets `site_url` or `additional_redirect_urls` to a non-https, localhost, 127.x or `host.docker.internal` value; or uses TOML
this strict checker does not understand (multi-line or single-quoted strings, inline tables, dotted keys, `[[arrays]]`, duplicates, reserved names).
The check inspects the committed file only and cannot see a hosted project's dashboard settings; hosted Auth URLs are otherwise covered by launch
step 5a. It is a required merge gate only once branch protection (#215) is configured.
