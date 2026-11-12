# Repository working agreement

This repository is at a README-only baseline. The monorepo foundation in issue #1 is
pending and is not approved; do not assume apps, scripts, or infrastructure exist.

## Issue and approval

Start with an issue. Before implementing or delegating a feature, verify that the issue
has the exact `approved` label. The team lead never self-approves; the lead may record
an owner’s explicit authorization to implement a named issue by applying that label with evidence, and
must verify the exact remote label before implementation. Do not infer approval from
vague discussion. Owner authorization in chat and verified labels permit issues #2
and #3; they do not approve issue #1 or other work. Classify work by its outcome, not its branch prefix: mixed feature and
bug work remains feature-gated, and a release branch does not bypass approval. For a
bug, document reproduction and scope. Proceed when its blast radius is small OR it is
clearly understood; otherwise seek owner approval before work.

Use a lowercase branch matching
`(feature|bug|release)/<app_name>-<issue-number>-<short-desc>`. Valid app names are
`ammu-sammu-customer`, `ammu-sammu-admin`, `konkan-fine-dine-customer`,
`konkan-fine-dine-admin`, and `monorepo`. Use lowercase letters, digits, and hyphens
for the short description.

## Team and delivery

The current chat is the team lead. Select roles, models, and thinking effort appropriate
to each task; trivial work may be done directly. Do not spawn all roles by default.
Choose skills by the substance of the work. Keep handoffs concise and explicit: issue,
approval evidence, scope, owned files, acceptance criteria, expected validation, and
review findings when applicable. Share the issue, branch, approval evidence, role and
model decisions, files, criteria, test evidence, and review gate concisely in a handoff
or PR body; do not create extra artifacts solely for this record. Collect reviewer
outcomes, resolve conflicts, and verify the changed-file count before a PR. UI/UX
review is not applicable when setup-only changes have no rendered UI,
interaction, navigation, accessibility, or user-facing product copy changes; docs and
tooling copy alone do not require product UI review.

A PR may change at most 15 reviewable files, counting additions, modifications,
deletions, and renames. Exclude only `.gitignore`, files whose basename is README
(including README.md), and objectively generated lockfiles. Handwritten configuration,
CI, tests, docs, agents, and skills count. Split work if needed. Request owner review
of the PR. Do not auto-merge. Do not start cloud builds or deployments unless
explicitly requested. Local build, export, and compile validation is allowed. Report
checks and limitations.
