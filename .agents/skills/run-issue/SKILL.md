---
name: run-issue
description: Route and deliver issue-scoped implementation with appropriate approval, reviews, and checks.
---

# Run an issue

1. Read `AGENTS.md`, the live issue, labels, checkout, and worktree. Preserve user work
   and existing local refs; main is read-only. Apply already authorized decisions within
   scope without asking again. Before feature implementation or delegation of it verify
   the exact remote `approved` label. A bug proceeds when its documented blast radius
   is small OR clearly understood; otherwise seek owner approval. Mixed feature and bug
   work is feature-gated; a release branch is not a bypass. Scope, approval, or genuine
   product/design ambiguity remains an owner decision. Every separate feature issue,
   including a child, requires its own exact `approved` label. Mechanical PR splits
   may remain under the already approved issue; parent authorization does not bypass
   another feature issue’s label.
2. Route by risk: **Fast** for bounded bugs or tooling; **Standard** for shared logic,
   orders, authentication, persistence, and similar risks; **Full** for material UI
   decisions. Select only needed roles, models, thinking effort, and relevant context;
   record choices per phase. Independent senior review is required for shared logic,
   auth/data, agent workflow, CI, and release changes. UI or user-facing copy requires
   UX review. Use BA only for unclear product value. Load only relevant sections of
   `.codex/reference/project-context.md` and inspect actual configuration and versioned
   documentation. Trivial work may be handled by the lead. Follow the selected sequence:

   - **Fast:** bounded brief and scoped plan, then build, checks, and applicable reviews.
   - **Standard:** technical Plan stage before build, with a senior when needed; then
     build, checks, and applicable reviews.
   - **Full:** settle material UI flow, states, and direction with pre-build UX evidence
     within approved scope; then a technical plan as needed, build, checks, and reviews.

   A real unresolved owner decision requires the owner; do not create a design label
   or separate approval gate otherwise. No mode mandates every role.
3. Plan criteria, risks, tests, and file ownership before editing. Limit each PR to 15
   reviewable files using the exclusions in `AGENTS.md`; if necessary split PRs within
   the approved issue and preserve its acceptance coverage. Never assign overlapping
   files to concurrent editors. Give each role a concise handoff with phase, issue,
   approval evidence, branch, role/model/thinking, scope, files, criteria, checks,
   references, and relevant findings. The developer delivers assigned work end to end.
4. Check criteria against actual results; gather independent reviews of the final diff.
   Authors and line-by-line planners cannot independently review their own work. Resolve
   disagreements with evidence, assign fixes, and obtain affected re-review. Reassess
   time and file budget with the lead during rework; do not arbitrarily pause for owner
   approval absent an actual scope, design, or other blocked decision. Refresh affected
   checks, reviews, and counts after changes; bind evidence to final head or reviewed
   diff. Do not claim readiness with unresolved blocking findings.
5. The lead alone opens or updates the PR when authorized, using an existing PR if present,
   and requests owner review. After push, wait for and check CI on the delivered head
   SHA. Repair failures and obtain affected re-review; report pending or unavailable
   checks as pending, never as passed. Include issue, approval, routing, scope, checks, reviews,
   decisions, remaining gaps, and final count in a concise PR body or report. No role
   posts autonomous issue comments. Normally leave merging to the owner. With explicit
   owner delegation for the current effort, the lead may merge the exact independently
   reviewed head after its checks pass, recording authority and review evidence. Never
   bypass protections or self-approve a GitHub review. Cloud builds and deployments
   require explicit request. Local tests, builds, exports, and compilation are allowed.

`--dry-run` reads only: no agents, branch, issue, label, PR, or other mutations. Report
approval, hypothetical routing, risks, roles, references, file budget, and blockers.
