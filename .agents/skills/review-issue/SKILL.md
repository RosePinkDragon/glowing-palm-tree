---
name: review-issue
description: Prepare and triage an issue through read-only investigation before implementation.
---

# Review an issue

Read `AGENTS.md`, the live issue and current labels, relevant files, and related issues;
look for duplicates. Classify by outcome, identify business and audience scope when
relevant, risk, dependencies, assumptions, testable acceptance criteria, and blocking
owner decisions. Record reproduction, actual and expected behavior, and scope for bugs.
Plan each PR against `main` with at most 15 reviewable files in the complete
`origin/main...HEAD` comparison, using the exclusions in `AGENTS.md`. Never plan
stacked/dependent publication or feature-branch merge targets. Same-issue slices
wait for the preceding PR to merge, then update from main; independent issues may
proceed in parallel. Include the required publication/update preflight:
`npm run pr:preflight -- --issue N --base main`.
Recommend Fast, Standard, or Full routing and explain which specialists are useful.
Use the BA only for a genuine product-value or requirements question; the lead can
triage technical work. Read only relevant sections of `.codex/reference/project-context.md`.

Preparation is read-only and may occur before approval; do not implement. Existing
owner authorization for issue updates permits recording accepted decisions without
reasking. Never self-approve or infer authorization from vague discussion. Specialists
return findings, criteria, and owner decisions to the lead. The primary chat coordinates,
consolidates criteria, routing and blockers, and reports them to the owner; preparation
is read-only by default, with issue updates only when authorized.
`--dry-run` performs reads only: no agents, branch, issue, label, PR, or other mutations;
report proposed routing and gates in chat.
