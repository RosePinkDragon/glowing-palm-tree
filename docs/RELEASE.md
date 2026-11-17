# Release setup

This repository does not create provider projects, configure credentials, or deploy the apps. Never commit private credentials or send them in chat. Public client configuration can be entered in Vercel's environment settings. Complete and verify the provider and launch steps below before accepting real orders.

## Web: four Vercel projects

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

## Migration policy (pre-release baseline)

Tracked by issue #131. Status: the baseline exists. `supabase/migrations/20261117000000_baseline.sql` is the single migration; it replaces the 17 development migrations (squashed in #131 slice S3, with a one-time file-cap exception recorded on the issue). It is not frozen: freezing happens at the first persistent deployment. No migration for this application has been applied to any persistent or shared database. Local disposable PostgreSQL/PostGIS runs in tests do not count.

The mode lives in `supabase/migration-policy.json` and is checked by `npm run pr:preflight` (author-run before publishing; the mode is read from `main`, so a PR cannot loosen its own rules). The trusted `Delivery policy` CI check also applies this guard, reading the policy pinned to a resolved main commit rather than using the PR's proposed policy. Unprivileged App CI separately validates that the checked-in proposed file is a JSON object with a known mode, so malformed configuration cannot poison later trusted runs. These workflow changes take effect once #143 merges into main. The explicit migration override is self-asserted by the author and requires owner review of the stated reason and deployment evidence; it never bypasses the file cap or frozen-history rule.

| Mode | Meaning | Guard |
| --- | --- | --- |
| `pre-release-open` | Squash not yet done; feature PRs may still add migration files. | Warns on added migration files. |
| `pre-release-baseline` (current) | One baseline exists and is not yet applied anywhere persistent. Fold schema changes into it. | Fails when a PR adds a file under `supabase/migrations/`. Override with a `Migration-Policy-Override: <reason>` line in the PR body (or `MIGRATION_POLICY_OVERRIDE=<reason>` in the environment), for example when a shared database has already applied the baseline; then move to `frozen`. |
| `frozen` | Baseline applied to a persistent or shared environment. Forward-only. | Fails when a PR modifies, deletes or renames an existing migration file; adding new files is allowed. No override. |

In `pre-release-baseline` mode, editing or deleting existing migration files is allowed (the squash needs it). The squash PR flips `pre-release-open` to `pre-release-baseline`; the PR that records the first persistent deployment flips `pre-release-baseline` to `frozen`. Because the mode is read from `main`, a flip takes effect once that PR merges.

Rules:

- Before the first persistent deployment, schema changes are folded into the single baseline once it exists. This concerns repository migration files, not avoiding schema changes.
- Freeze trigger: the moment the baseline is applied to any persistent or shared environment (staging included), or at release cutover, whichever is first. Set `mode` to `frozen` and record the baseline migration version and the commit SHA in `supabase/migration-policy.json` (`baseline`: `{ "version": "...", "commit": "..." }`) in the same PR. Today the file reads `{ "mode": "pre-release-baseline", "baseline": null }`; the freeze PR changes it to, for example, `{ "mode": "frozen", "baseline": { "version": "20261117000000", "commit": "<sha of the commit that applied it>" } }`. Nothing is deployed yet, so the mode stays `pre-release-baseline` until then.
- Never rewrite, reorder or delete migration history that any shared or persistent database has applied, and never reset a database holding real data to comply with this policy. If anything has been applied, stop rewriting and append forward-only migrations.
- The two `dukan-dar` Supabase projects are separate Prisma-managed databases. Never link, push to or otherwise change them. Verify the intended project ref and its migration history are new and empty before any database write.

Release-readiness gate before switching to forward-only:

1. Deploy the single baseline to the new, empty Supabase project (step 2 above).
2. Verify seed and reference data, security (RLS, tenant isolation, grants, Supabase advisers), roles and memberships, the `menu-images` storage bucket, Realtime publications, and the critical flows (checkout, order transitions, notifications).
3. Record the baseline version and commit, set `mode` to `frozen`.

## Firebase, analytics, and notifications

1. Create one Firebase project for the environment and register four web apps, one per target. In Firebase Console → Project settings → General → Your apps, select each web app and copy its public config into the matching Vercel project's `EXPO_PUBLIC_FIREBASE_API_KEY`, `PROJECT_ID`, `MESSAGING_SENDER_ID`, and `APP_ID` variables. The prefix for each is `EXPO_PUBLIC_FIREBASE_`. Firebase client config is public; control access through provider settings and security rules. Supabase provides authentication for these apps.
2. For analytics, find the web app's measurement ID in its Firebase web config or Google Analytics → Admin → Data streams → the web stream, and set `EXPO_PUBLIC_FIREBASE_MEASUREMENT_ID`. In that same stream turn **Enhanced Measurement** off, verify it is off for the actual stream, and only then set `EXPO_PUBLIC_FIREBASE_ANALYTICS_STREAM_VERIFIED=true`. Leave it false until verified. Analytics also requires user consent.
3. For web push, find or generate the public Web Push certificate key pair in Firebase Console → Project settings → Cloud Messaging → Web Push certificates and set its public key as `EXPO_PUBLIC_FIREBASE_VAPID_KEY`. Configure Firebase Cloud Messaging for the project. Verify permission, token registration, and delivery on each deployed origin.
4. Deploy `dispatch-notifications` with the Supabase CLI from a trusted machine after linking the correct project: `supabase functions deploy dispatch-notifications`. In Firebase Console → Project settings → Service accounts, choose **Generate new private key** on a trusted machine. Upload the resulting JSON as the Supabase Edge Function secret `FCM_SERVICE_ACCOUNT` (it contains `project_id`, `client_email`, and `private_key`), and store a strong `NOTIFICATION_DISPATCH_SECRET` of at least 32 characters in Supabase Edge Function secrets. The function also uses Supabase's server-side `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. Keep these private values out of chat, GitHub, and Vercel frontend variables. Configure a trusted scheduler to POST to the deployed function URL with `Authorization: Bearer <NOTIFICATION_DISPATCH_SECRET>`; the function checks that secret and has JWT verification disabled specifically for this endpoint. Verify scheduling and delivery without exposing the secret. See [function notes](../supabase/functions/dispatch-notifications/README.md).

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
