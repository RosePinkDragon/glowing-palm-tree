# npm dependency audit

App CI runs the dependency gate before installation in its existing `quality` job. It audits the committed workspace lockfile, including development dependencies, using `npm audit --package-lock-only --json --audit-level=low --include=dev --include=optional --include=peer`. Run the same policy locally with Node 24 using `node .github/scripts/dependency-audit.mjs`. The required status check stays `ci`.

- **Pushes to main and manual runs** always run the gate.
- **Pull requests** run it whenever `quality` runs. Lockfile and root manifest changes trigger all jobs. Workspace dependencies and npm configuration changes also reach `quality`. Edits to the allowlist in `docs/policy/` or gate code in `.github/scripts/` trigger `quality` via the scripts flag. PRs without relevant changes, such as prose-only or SQL-only changes, can skip it.
- **High and critical** direct advisories block by default. Moderate, low and informational findings are reported. npm also reports affected parents of an advisory as metavulnerabilities. The gate follows those to their underlying advisory. Registry, timeout and invalid-report errors fail the job. The gate logs advisory IDs, pinned package locations, versions and decisions rather than printing the raw report.

High advisories may be accepted with an owner-reviewed entry in [the allowlist](policy/npm-audit-allowlist.json). Each entry requires `advisory` (exact GHSA), `path` (exact lockfile package path), `version` (exact pinned version), `expires` (UTC date, first day on which the exception stops applying), and `reason` (why the risk is acceptable and what would change that). Critical advisories have no exception. Before expiry, verify the affected use and patched versions. Remove the entry once the dependency is fixed. Ask the repository owner listed in CODEOWNERS to review every allowlist change before merging.

## Audit snapshot

On 2026-11-26 at `3a0c996`, the npm registry returned seven affected-package rows for the pinned lockfile. Three direct advisories account for those rows. The dependency paths below describe packages present in the lockfile and their use in this repository.

| Advisory | Installed dependency path | Scope and disposition |
| --- | --- | --- |
| [GHSA-m9gg-hp2v-232j](https://github.com/advisories/GHSA-m9gg-hp2v-232j), high | `@market/notifications → firebase@13.3.0 → @firebase/firestore@4.20.0 → @grpc/grpc-js@1.9.16`. `@firebase/firestore-compat@0.4.18` also depends on Firestore. | Listed as production. The advisory concerns gRPC server authentication. The web app and service worker import Firebase App, Analytics, Messaging and Performance. No Firestore or gRPC server imports were found in app or package source. The fixed gRPC version (1.13.6) is outside Firestore's pinned `~1.9.0` range. npm proposes a major Firebase downgrade. Time-limited exception for the pinned copy while evaluating a compatible upgrade. |
| [GHSA-f596-whhp-79r4](https://github.com/advisories/GHSA-f596-whhp-79r4), low | Same Firebase and Firestore dependency path. | Listed as production. Concerns a gRPC server exposing internal errors. Reported under the policy. The fixed gRPC version and npm upgrade constraints are the same as above. |
| [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249), moderate | `expo@58.0.25 → @expo/fingerprint@0.21.10 → minimatch@10.2.6`. | Listed as production in the lockfile. Known use is Expo fingerprint tooling during builds, with repository-controlled inputs. Review any use with untrusted glob patterns. The fixed minimatch version (11.0.1) is outside Fingerprint's `^10.2.6` range. npm proposes a major Expo downgrade. Reported under the policy. |

The gate is the dependency-check slice of #214. Compatible dependency remediation, secret scanning and static analysis remain follow-up work.
