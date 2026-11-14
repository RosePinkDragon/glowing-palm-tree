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

The export places `firebase-messaging-worker.js` at the same-origin root. The configuration requires revalidation of this worker so updates can reach browsers. Current views use React state and the root callback query, so no SPA rewrite is needed. After deployment, open each domain, verify its callback, and inspect the root worker response and its `Cache-Control` header. Report a live URL only after deployment and browser verification.

## GitHub branch protection

A repository administrator should open GitHub **Settings → Branches** (branch protection rules) or **Settings → Rules → Rulesets** and protect `main`: require pull requests, require passing checks (`Delivery policy`, `quality`, `export`, `tests`, `policy`, `validate`, `postgis-rls`, and `dispatcher`), require branches to be up to date before merging, and disallow force pushes. After the browser QA workflow is merged and its check is available, require the `browser` check as well. Select the intended check sources where available and consult [the repository workflow](WORKFLOW.md) for enforcement limits and review policy. These protections are account settings and are not established by this repository.

A formal GitHub approval requires a distinct eligible reviewer; agent review reports or PR comments are not GitHub approvals, and the PR author cannot approve their own PR. Arrange an eligible reviewer before requiring formal approval or CODEOWNERS review so the rule is workable.

## Supabase and launch data

1. Create one Supabase project for the intended environment. In the dashboard, use **Connect** for the Project URL and **Project Settings → API Keys** for the publishable key (the legacy `anon` key also works). Set `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_ANON_KEY` in all four Vercel projects. These are public client values; never expose the service-role key.
2. From a trusted machine, authenticate the Supabase CLI, link the intended project with `supabase link --project-ref <project-ref>`, review the target and migrations, then run `supabase db push`. Both businesses share this database; verify row-level security and cross-business isolation with appropriate accounts. `supabase/seed.sql` is demonstration data, not a production catalog or verified boundary; don't use it as launch data. Keep business and menu `is_demo` flags consistent with real, reviewed data.
3. Configure **Supabase Auth** and its implemented sign-in method. In Authentication → URL Configuration, add the four exact production domain roots to Redirect URLs; add only current trusted preview roots if previews need authentication. A separate staging project is preferable for previews. Set the Site URL appropriately and verify sign-in and callback on each app. Avoid broad preview wildcards.
4. Through a trusted administrative database setup, create the appropriate `business_memberships` for authenticated admin users and verify each admin can access only their business. Do not distribute service credentials to clients.
5. Before enabling ordering, obtain and independently verify the Khed, Ratnagiri delivery boundary as GeoJSON for each business. Record its source, version, and verification timestamp with the valid service-area geometry. Confirm actual menu items and prices, delivery fees, minimum orders, and cash-on-delivery terms with the businesses. Replace demo data, review `is_demo` and `ordering_enabled`, and test the server-enforced checkout and geographic boundary before enabling real orders.

## Firebase, analytics, and notifications

1. Create one Firebase project for the environment and register four web apps, one per target. In Firebase Console → Project settings → General → Your apps, select each web app and copy its public config into the matching Vercel project's `EXPO_PUBLIC_FIREBASE_API_KEY`, `AUTH_DOMAIN`, `PROJECT_ID`, `STORAGE_BUCKET`, `MESSAGING_SENDER_ID`, and `APP_ID` variables. The prefix for each is `EXPO_PUBLIC_FIREBASE_`. Firebase client config is public; control access through provider settings and security rules. Supabase provides authentication for these apps.
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
