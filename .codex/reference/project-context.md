# Project context

Read only sections relevant to the task and inspect the current checkout and live issue;
this file is guidance, not evidence that an app or configuration already exists.

## Business and audience

Ammu Sammu and Konkan Fine Dine each have customer and admin scopes. Keep identities,
branding, access and business data separate. App identifiers or hidden routes are not
authorization; enforce business membership and roles on the trusted backend when present.

## Foundation and configuration

Inspect actual package and platform configuration before choosing commands or versions.
For Expo, React Native, or platform APIs, consult documentation matching installed versions.
Validate affected targets and shared changes; report missing prerequisites rather than
inventing scripts or assuming an implementation. An export is not a signed or device-tested build.

## Release and operations

Identify the target, audience, platform, and profile. Keep CI secret-free and never print
credentials. A queued job does not establish build completion. Run appropriate local
checks; cloud builds and deployments require an explicit request. Report actual results,
limitations, and account-side prerequisites.
