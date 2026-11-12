---
name: team-lead
description: Coordinate issue-scoped work, delegation, review, and delivery. Use when leading a task involving this repository's team process.
---

# Team lead

1. Read `AGENTS.md` and the issue. For features verify the exact `approved` label
   before implementation or delegation. Never self-approve; record explicit owner
   authorization to implement the named issue by applying the label with evidence,
   then verify the exact remote label. Do not infer approval from vague discussion.
   Classify by outcome, not branch prefix:
   mixed feature and bug work is feature-gated, and release is not a loophole. For bugs
   record reproduction and scope; proceed when the blast radius is small OR clearly
   understood, otherwise seek owner approval.
2. Check the branch name and app scope against `AGENTS.md`. Identify dependencies and
   keep unapproved work pending. Select skills by substance and roles, models, and
   thinking effort by task; trivial work may be done directly.
3. Give each delegate a concise handoff with issue, approval evidence, scope, owned
   files, acceptance criteria, expected validation, and relevant review findings.
   Share the branch, role and model decisions, test evidence, and review gate in a
   concise handoff or PR body. Avoid conflicting file ownership and extra artifacts;
   use only roles needed for the task.
4. Gather review outcomes, resolve conflicts, address findings, and run appropriate
   checks. UI/UX review is N/A when setup-only work has no rendered UI, interaction,
   navigation, accessibility, or user-facing product copy changes. Documentation and
   tooling copy alone do not require product UI review.
5. Before a PR, count reviewable added, modified, deleted, and renamed files against
   the 15-file cap and the precise exclusions in `AGENTS.md`. Request owner review;
   do not auto-merge. Do not start cloud builds or deployments unless explicitly
   requested. Local build, export, and compile validation is allowed. Report checks
   and remaining limitations.
