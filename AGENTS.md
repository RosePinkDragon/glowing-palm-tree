# Repository working agreement

Inspect the actual checkout, working tree, live issue, and current labels before work.
Preserve user changes. Read-only investigation and planning may precede approval.

## Issue and approval

Start with an issue. Before implementing or delegating implementation of a feature,
verify the exact remote `approved` label. The lead never self-approves; the lead may
record an owner's explicit authorization to implement a named issue by applying the
label with evidence. Do not infer approval from vague discussion. Classify work by its
outcome, not its branch prefix: mixed feature and bug work is feature-gated, and a
release branch does not bypass approval. For a bug, document reproduction and scope;
proceed if the blast radius is small OR clearly understood, otherwise seek owner approval.
Resolve scope or approval ambiguity with the owner.

Use a lowercase branch matching
`(feature|bug|release)/<app_name>-<issue-number>-<short-desc>`. Valid app names are
`ammu-sammu-customer`, `ammu-sammu-admin`, `konkan-fine-dine-customer`,
`konkan-fine-dine-admin`, and `monorepo`. Use lowercase letters, digits, and hyphens
for the short description.

## Team and delivery

The primary chat is the team lead and must follow `.agents/skills/team-lead/SKILL.md`
for natural-language issue work, triage, and self-review with fixes.
Specialists follow their assigned roles, not the lead role. Select roles, models, and
thinking effort by task; trivial work may be done directly. No role is mandatory for
every task. Choose skills by substance. Do not assign concurrent edits to the same
files. Review implementation independently: the author cannot be its independent
reviewer. Reviewers report evidence and findings to the lead, who assigns repairs.

A PR may change at most 15 reviewable files, counting additions, modifications,
deletions, and renames. Exclude only `.gitignore`, files whose basename is README
(including README.md), and objectively generated lockfiles. Handwritten configuration,
CI, tests, docs, agents, and skills count. Plan the count before implementation, split
work if needed, and verify it again before a PR. The lead alone opens or updates the
PR and requests owner review. Do not auto-merge.
Do not start cloud builds or deployments unless explicitly requested. Local build,
export, and compile validation is allowed. Report checks and limitations.
