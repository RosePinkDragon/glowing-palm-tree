# Delivery workflow

The owner may explicitly delegate review-based issue approval and merging for a defined
effort. Record that authorization on the issue; apply `approved` only after the relevant
scope review, and merge only the independently reviewed head with passing checks. Without
such delegation, the owner-review defaults below apply. Delegation does not permit
self-approval of a GitHub review, protection bypasses, or unreviewed new scope.

1. Open an issue before starting work. Features need acceptance criteria and the exact `approved` label from an authorized maintainer before work begins. A `feature/` branch or an issue labeled `feature` or `enhancement` requires approval, including when a feature issue uses a `bug` or `release` branch.
2. A bug without `approved` needs an `Assessment` section containing exactly `small` or `understood`. For `small`, explain the scope in the `Small blast radius` section. For `understood`, describe both reproduction and impacts in their sections. Placeholder answers are rejected. Unknown classification or an unclear bug requires `approved`. The gate checks structure and common placeholders, not the quality or truth of the assessment; reviewers must assess it. Approval authority belongs to the repository's authorized maintainers.
3. Create a branch named `(feature|bug|release)/<scope>-<issue-number>-<short-desc>`, using lowercase letters, digits and hyphen-separated description words. The positive issue number has no leading zero. Allowed scopes are `ammu-sammu-customer`, `ammu-sammu-admin`, `kokani-dine-inn-customer`, `kokani-dine-inn-admin`, and `monorepo`. A release branch does not bypass feature approval.
4. Open every PR against `main` with exactly one `Issue: #N` line, or `Issue: https://github.com/OWNER/REPO/issues/N` with the same repository. The linked issue must exist, be open, and match the branch number. Complete summary, validation, file count, and any useful handoff or decisions. Leave PRs open for owner review; do not automatically merge.
5. Never publish stacked or dependent PRs or use feature branches as merge targets. Split a large issue sequentially: wait for its preceding PR to merge, update/rebase from current main, then publish the next slice. Independent issues may proceed in parallel. Before every PR publication or update, run `npm run pr:preflight -- --issue N --base main` on a clean, committed head. It fetches fresh `origin/main`, verifies its ancestry and origin GitHub identity, counts the complete `origin/main...HEAD` diff, and reads all live open PRs. Another open PR for the issue blocks publication; updating the exact same head-branch PR is allowed if it targets main. GitHub, remote, fetch or incomplete metadata failures block preflight. Rerun after any head/main change. Do not use a feature/local base to hide cumulative changes.
6. Keep each PR to at most 15 reviewable files in that complete main comparison. Additions, modifications, deletions and renames count. A rename counts if either path is reviewable. Only `.gitignore`, `README`, `README.md`, `README.rst`, `README.txt`, and the following exact generated lockfile basenames are excluded: `package-lock.json`, `npm-shrinkwrap.json`, `yarn.lock`, `pnpm-lock.yaml`, `bun.lock`, `bun.lockb`, `Cargo.lock`, `Pipfile.lock`, `poetry.lock`, `uv.lock`, `Gemfile.lock`, `composer.lock`, `go.sum`. Other generated files, documentation, configuration, tests and workflows count.

The `Delivery policy` check reads live issue and PR metadata, paginates file lists, and fails when data is incomplete. It reevaluates PRs on opening, editing (including base changes), synchronization, reopening and ready-for-review, and on issue label, body or state changes, deletion, and transfer, and default-branch pushes. Each event reevaluates all open PRs; every open PR must have a distinct head commit because GitHub checks are attached to commits. The privileged workflow checks out only the trusted base and does not run PR code. The dependency-free Node 24 helpers live in `.github/scripts`; run `node --test --test-isolation=none .github/scripts/delivery-policy.test.mjs .github/scripts/pr-preflight.test.mjs` locally. Policy tests run separately with read-only permissions. A check cannot prove work was actually delayed until approval; maintainers must enforce that process.

Workflows introduced by a PR only become effective after merge into the default branch. After merging, a repository administrator must activate an additive ruleset requiring the `Delivery policy` check as described below, preserving existing protections. A required human or CODEOWNERS approval also needs a distinct eligible reviewer; do not configure an impossible self-review gate for a sole owner. These settings are separate from this repository's files. A check name alone can be spoofed by another same-repository workflow; restrict who can change workflows and policy, and configure the required check's source where GitHub supports it. Pinning the check source to GitHub Actions still allows another workflow from that same app to emit the same check name. Stronger enforcement requires a supported ruleset-required workflow or an independently identified policy app. CODEOWNERS requests review but does not itself enforce approval. The workflow checks for stale state before publishing, but API updates and check publication are not atomic; a subsequent event reevaluates changes, and maintainers should rerun the workflow if a race or API failure prevents publication. A GitHub API outage can prevent creation or completion of a check, so remote failure cannot always be guaranteed; an in-progress check remains pending if completion fails.

GitHub does not allow a PR author to approve their own PR. Before requiring CODEOWNERS
approval, arrange a distinct eligible reviewer: if the connector authors PRs as the sole
owner, that owner cannot supply the required review. Agent review reports do not satisfy
GitHub's human-review requirement. If GitHub cannot list PRs or accept check updates, a
previous successful check may remain visible; do not treat the automation as proof of
approval or as a substitute for merge protections and owner review.

The preflight enforces agent publication workflow; it does not ban every human from
creating stacked PRs in GitHub. The existing Delivery policy CI checks main-only PR
targets, but a required merge gate needs live repository settings.

The additive settings proposal is `docs/policy/main-delivery-ruleset.json`; it has
not been activated. Attempts to inspect branch protection and create a ruleset
returned HTTP 403 (`Resource not accessible by integration`); the available token
cannot activate it. An owner with repository administration permission can import
this JSON at GitHub **Settings → Rules → Rulesets → New ruleset → Import a ruleset**,
review and save it, or run:

```sh
gh api --hostname github.com --method POST repos/RosePinkDragon/glowing-palm-tree/rulesets --input docs/policy/main-delivery-ruleset.json
```

Create this as an additional ruleset and preserve existing protections. The payload
requires PRs and the `Delivery policy` status from GitHub Actions (app ID 15368),
with an up-to-date branch, no bypass actors, and zero mandatory human approvals
to avoid locking out a sole owner who authors the PR. Independent agent review
remains required by this workflow. After saving, verify the ruleset is active and
targets main, the required check appears with its configured source, and an
unqualified PR cannot merge. Until that verification, do not report the required
gate as active. This gate does not universally forbid human feature-branch merges.
