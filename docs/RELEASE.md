# Release setup

This repository contains release configuration, not release credentials or provider
projects. The app workspaces and provider implementations must be present before a
build can run. Never add service credentials, signing keys, provider private keys, or
real project identifiers to the repository.

## App targets

Create one EAS project and one GitHub environment for each app. Native identifiers are
defined in `config/app-targets.json` and shared by app configuration:

| App | iOS bundle ID and Android package |
| --- | --- |
| `ammu-sammu-customer` | `com.rosepinkdragon.ammusammu.customer` |
| `ammu-sammu-admin` | `com.rosepinkdragon.ammusammu.admin` |
| `konkan-fine-dine-customer` | `com.rosepinkdragon.konkanfinedine.customer` |
| `konkan-fine-dine-admin` | `com.rosepinkdragon.konkanfinedine.admin` |

## Supabase

1. Create a Supabase project for the intended environment and record its URL and
   publishable anon key. Put them in the app's public runtime configuration as
   `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_ANON_KEY`.
2. From a trusted development machine, install or run the Supabase CLI, authenticate,
   and link the intended project:
   ```sh
   supabase link --project-ref <project-ref>
   supabase db push
   ```
   Review the SQL and target project before applying it. The schema uses
   PostGIS and enables ordering only after a delivery area has been verified.
3. Configure Supabase Auth providers and the exact web/native redirect URLs for the
   app. Verify row-level-security policies and the service-area data before enabling
   customer ordering. `supabase/seed.sql` contains demo catalog rows only; it does not
   define a verified delivery area.
4. Keep the Supabase service-role key in a trusted server or function secret store. It
   must never be included in an `EXPO_PUBLIC_*` variable, app bundle, or `.env.example`.

## Firebase

1. Create or select the Firebase project for the intended environment. Register each
   platform app using the identifiers in the table above.
2. Enable only the Firebase Auth providers the product has implemented, and configure
   authorized domains and OAuth redirect URLs to match the deployed app origins.
3. Copy the web app's public Firebase configuration into the corresponding
   `EXPO_PUBLIC_FIREBASE_*` entries from `.env.example`. Firebase client configuration
   is public and must be protected with Firebase Security Rules and provider settings.
4. Store Firebase Admin credentials and other private keys only in server-side secret
   storage. Do not add `google-services.json`, `GoogleService-Info.plist`, private
   keys, or service-account files to this repository. Configure any required native
   Firebase files through EAS secret file variables after the app config consumes
   them.
5. Push notifications are not configured by these release pipelines. Register APNs
   and FCM credentials in EAS only when the notification implementation and its
   permission flows are ready.

## EAS native builds

1. In Expo, create a separate EAS project for each app target. Use the matching native
   identifiers above and record that project's UUID; no project UUID is committed.
2. In GitHub Settings, create an environment whose name exactly matches each app key.
   Add `EXPO_TOKEN` as an environment secret and that app's `EAS_PROJECT_ID` as an
   environment variable. Add `EXPO_OWNER` as a variable only if the Expo project uses
   an owner. Use a distinct project UUID for each app.
3. The shared config reads `EXPO_PUBLIC_EAS_PROJECT_ID`, validates its UUID format,
   and places it in `extra.eas.projectId`. The workflow maps the selected environment's
   `EAS_PROJECT_ID` into that public config value. It also validates the token and
   project ID before invoking EAS.
4. After the app workspace and credentials exist, open **Actions → Manual EAS Build**,
   select an app, platform, and `preview` or `production` profile, then run it
   deliberately. The workflow uses EAS CLI `27.9.0`. Preview builds use internal
   distribution; production builds create binaries on the production channel. No
   build starts automatically and no store submission is configured.
5. Configure or verify Apple and Google signing credentials in EAS. Perform store
   metadata, privacy, and release review separately before submitting binaries.

## Manual GitHub Pages preview

**GitHub Pages is currently disabled, so no preview URL is live.** After this workflow
is merged to `main`, a repository administrator should verify Pages is available and
that the `github-pages` environment and Actions permissions are suitable. Then open
**Actions → Manual Web Preview** on `main` and run it manually. The workflow checks out
`main`, exports each app under `/glowing-palm-tree/<app-key>/`, and deploys the
combined artifact with GitHub's Pages actions. The configure step requests Pages
enablement; report a published preview only after a successful deployment and a
browser check of all four app paths.

## Remaining launch gates

- Add and review actual app workspaces, then configure the four Expo projects and GitHub
  environments. This change does not create app code or provider project IDs.
- Connect the chosen Supabase or Firebase Auth implementation and verify production
  security rules. Keep provider private credentials server-side.
- Configure and verify production delivery-area geometry, ordering controls, and the
  server-authoritative order endpoint before accepting real orders. Demo data is not a
  launch-ready service area.
- Add push credentials and permission handling only with the notification feature.
- Run the manual preview workflow and native build workflows after credentials and
  platform signing are configured. CI exports web/native app artifacts, but these are
  not deployments or store releases.
