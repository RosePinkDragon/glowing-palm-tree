# Repository working agreement

Inspect the actual checkout, working tree, live issue, and current labels before work.
Preserve user changes. Read-only investigation and planning may precede approval.

## Issue and approval

Start with an issue. Before implementing or delegating implementation of a feature,
verify the exact remote `approved` label. The lead never self-approves; the lead may
record an owner's explicit authorization to implement a named issue by applying the
label with evidence. An owner may explicitly delegate applying approval after relevant
agent review for a defined scope; record that authority and review before labeling.
Do not infer approval from vague discussion. Classify work by its
outcome, not its branch prefix: mixed feature and bug work is feature-gated, and a
release branch does not bypass approval. For a bug, document reproduction and scope;
proceed if the blast radius is small OR clearly understood, otherwise seek owner approval.
Resolve scope or approval ambiguity with the owner.

Use a lowercase branch matching
`(feature|bug|release)/<app_name>-<issue-number>-<short-desc>`. Valid app names are
`ammu-sammu-customer`, `ammu-sammu-admin`, `kokani-dine-inn-customer`,
`kokani-dine-inn-admin`, and `monorepo`. Use lowercase letters, digits, and hyphens
for the short description.

## Team and delivery

The primary chat is the team lead and must follow `.agents/skills/team-lead/SKILL.md`
for natural-language issue work, triage, and self-review with fixes.
Specialists follow their assigned roles, not the lead role. Select roles, models, and
thinking effort by task; trivial work may be done directly. No role is mandatory for
every task. Choose skills by substance. Do not assign concurrent edits to the same
files. Review implementation independently: the author cannot be its independent
reviewer. Reviewers report evidence and findings to the lead, who assigns repairs.

Every PR must target `main`. Never publish stacked or dependent PRs or use a feature
branch as a merge target. For sequential slices of one issue, wait until the preceding
PR merges, update from fresh `origin/main`, then publish the next slice. Independent
issues may proceed in parallel. Before every PR publication or update, the lead must
run `npm run pr:preflight -- --issue N --base main` successfully on the committed head.
The command fetches current main and checks ancestry, the complete main-relative diff,
and live open PRs; resolve failures before publishing. Updating the exact existing
head-branch PR is allowed; another open PR for the same issue blocks a new slice.

A PR may change at most 15 reviewable files, counting additions, modifications,
deletions, and renames. Exclude only `.gitignore`, files whose basename is README
(including README.md), and objectively generated lockfiles. Handwritten configuration,
CI, tests, docs, agents, and skills count. Plan the complete `origin/main...HEAD`
count before implementation, split work sequentially if needed, and verify it again
before a PR. Never use a local or feature-branch comparison to hide cumulative
changes. The lead alone opens or updates the PR and normally requests owner review. With explicit owner delegation for the current
effort, the lead may merge only the independently reviewed head after its checks pass.
Record authority and review evidence; never bypass protections or self-approve a
GitHub review.
Do not start cloud builds or deployments unless explicitly requested. Local build,
export, and compile validation is allowed. Report checks and limitations.
