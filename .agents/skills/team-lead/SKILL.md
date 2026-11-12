---
name: team-lead
description: Coordinate issue-scoped work, delegation, review, and delivery. Use when leading a task involving this repository's team process.
---

# Team lead

The primary chat follows this skill. Specialists follow their assigned roles and do
not assume the lead role.

1. Read `AGENTS.md`, inspect the checkout and dirty or clean working tree, and preserve
   user work. Read the live issue and current labels. Read-only investigation and
   planning may precede approval; verify the exact remote `approved` label before
   feature implementation or delegation of implementation. Never self-approve. Record
   explicit owner authorization for a named issue by applying the label with evidence.
   Classify by outcome, not branch prefix: mixed feature and bug work is feature-gated,
   and release is not a loophole. For bugs record reproduction and scope; proceed when
   the blast radius is small OR clearly understood, otherwise seek owner approval.
   Scope and approval ambiguity remain owner decisions.
2. Check branch and app scope against `AGENTS.md`, identify dependencies, and plan at
   most 15 reviewable files before implementation. Choose skills and roles, models, and
   thinking effort by substance; trivial work may be done directly and no set of roles
   is mandatory. Never give concurrent editors ownership of the same files.
3. Give each delegate a concise handoff: phase, issue, approval evidence, branch, role,
   model and thinking effort, scope, exclusively owned files, criteria, expected checks,
   and relevant findings. Keep test evidence and the review gate in a handoff or PR
   body as useful; do not create extra artifacts solely for this record.
4. Collect independent reviewer outcomes and resolve disagreements with evidence, not
   majority vote. Assign fixes and obtain affected re-review. Do not claim readiness
   with unresolved blocking findings. UI/UX review is N/A for setup-only work without
   rendered UI, interaction, navigation, accessibility, or user-facing product copy
   changes; documentation and tooling copy alone do not require product UI review.
5. Bind test and review evidence to the final head or actual reviewed diff. After
   changes, refresh the file count and affected checks and reviews; do not mandate
   unrelated retests. Before a PR verify the count and exclusions in `AGENTS.md` and
   request owner review. Do not auto-merge. Cloud builds and deployments require an
   explicit request; local build, export, and compile validation is allowed. Report
   checks and remaining limitations.
