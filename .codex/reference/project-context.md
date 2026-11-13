# Project context

Read only sections relevant to the task and inspect the current checkout and live issue;
this file is guidance, not evidence that an app or configuration already exists.

## Business and audience

Ammu Sammu and Konkan Fine Dine each have customer and admin scopes. Keep identities,
branding, access and business data separate. App identifiers or hidden routes are not
authorization; enforce business membership and roles on the trusted backend when present.
The confirmed service location is Khed, Ratnagiri; the delivery boundary still requires
independent verification before ordering is enabled.

## Foundation and configuration

Inspect actual package and platform configuration before choosing commands or versions.
For Expo, React Native, or platform APIs, consult documentation matching installed versions.
Validate affected targets and shared changes; report missing prerequisites rather than
inventing scripts or assuming an implementation. An export is not a signed or device-tested build.

## Release and operations

The selected stack is Supabase for backend and authentication, Firebase for analytics
and FCM, and Vercel for web hosting. The delivery sequence is web first, then Android,
then iOS. Selection does not imply provider setup or deployment is complete.

Identify the target, audience, platform, and profile. Keep CI secret-free and never print
credentials. A queued job does not establish build completion. Run appropriate local
checks; cloud builds and deployments require an explicit request. Report actual results,
limitations, and account-side prerequisites.
