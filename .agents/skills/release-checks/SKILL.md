---
name: release-checks
description: Review release readiness and CI for an authorized target without starting cloud builds or deployments unless explicitly requested.
---

# Release checks

Read `AGENTS.md` and the issue first; issue #1 is pending and unapproved. Inspect
actual configuration before selecting checks. Identify the business, audience,
platform, and profile for authorized release work. Verify relevant local checks and
report results, prerequisites, and limitations. Keep ordinary CI secret-free and do
not print credentials. A queued job does not prove a build completed. Do not start cloud builds or deployments unless explicitly requested. Local build,
export, and compile validation is allowed. Do not submit to stores as part of review.
