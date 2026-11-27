# Source security in App CI

The `source-security` job runs before App CI jobs that build, test or upload artifacts. The existing `ci` check requires it to succeed. A skipped, failed or cancelled scan fails `ci`.

## Secret scanning

Gitleaks 8.30.0 uses the release archive pinned by SHA-256 in App CI and the bundled default rules. App CI loads full Git history and checks the following revisions.

| Event | Commits scanned |
| --- | --- |
| Pull request, including docs-only edits | Base SHA through the PR head, excluding the base and its ancestors. A missing base or head fails the job. |
| Push to main | Previous tip through the new tip, excluding commits already reachable from the previous tip. If Git cannot find the previous tip, scan all history reachable from the new tip. |
| Manual App CI run | All locally fetched refs and the checked-out commit, with their full histories. |

The scanner examines merge diffs against their first parent while walking the selected commits. It enables full Gitleaks redaction, suppresses the scanner's output, and writes no report or artifact. A test creates a synthetic token in a temporary docs commit, removes it in a second commit, and verifies that the three scan modes and the same `ci` script fail without echoing the value or creating a report.

Use [the fingerprint allowlist](../.gitleaksignore) only for verified false positives. Add the exact `commit:path:rule:line` fingerprint with a comment that explains the exception. Ask the repository owner to review each addition. Inline Gitleaks suppression comments are ignored. The initial history scan identified five fingerprints for the same synthetic UUID fixture. The allowlist records those five specific false positives.

For private triage, run Gitleaks 8.30.0 against the failing range with `--redact=100`, `--config .github/security/gitleaks.toml`, `--ignore-gitleaks-allow` and `--log-opts='${base}..${head} --diff-merges=first-parent'` (substitute the actual commits). Keep any local report private. Share only the rule and a safe location. If a real credential is found, rotate it promptly.

## Static analysis

Semgrep 1.187.0 uses the checked-in [rule set](../.github/security/semgrep.yml) for `.github/scripts`, `packages/services` and `supabase/functions`. Analysis is limited to those three trees. Changes classified as app, repository scripts or Edge Functions trigger the scan, as do main pushes and manual runs. Other app directories and packages, including `apps/` and `packages/core`, are outside the scanned targets. The job prints counts only. Scanner errors fail the job. Inline Semgrep suppression comments are disabled.

CI installs the Linux x86-64 Python 3.12 lock with `pip install --require-hashes --only-binary=:all: -r .github/security/semgrep-requirements.txt`. Review every dependency and hash change. Regenerate the lock with:

```sh
uv pip compile --system-certs --generate-hashes --python-version=3.12 --python-platform=x86_64-manylinux_2_34 \
  --only-binary=:all: .github/security/semgrep-requirements.in -o .github/security/semgrep-requirements.txt
```

The integration runner takes exactly one suite name, `secrets` or `static`. Unknown, missing and extra arguments fail before any scan starts.

The initial report-only run at the `4e8f21b` baseline found zero matches across 52 files after one parser exception. Semgrep reports a syntax error in `.github/scripts/delivery-policy.mjs`; `node --check` accepts it, and App CI runs its Node tests. The scan excludes that exact path. Recheck the exception on the next Semgrep upgrade.

| Rule | Policy |
| --- | --- |
| `dynamic-javascript-evaluation` | Blocks direct `eval`, `Function` and `new Function` calls. |
| `disabled-tls-certificate-verification` | Blocks literal TLS verification disablement in JavaScript and TypeScript. |
| `explicit-subprocess-shell` | Report-only. A shell option warrants review and can be intentional. |

With the pinned scanner binaries on `PATH`, run `node .github/scripts/source-security.mjs static` for the CI behavior. For private source-level triage, run `semgrep scan --oss-only --strict --metrics=off --disable-version-check --disable-nosem --exclude=/.github/scripts/delivery-policy.mjs --config .github/security/semgrep.yml .github/scripts packages/services supabase/functions`.
