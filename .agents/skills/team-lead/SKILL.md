---
name: team-lead
description: Route the primary chat's issue work, implementation, and self-review through the appropriate workflow.
---

# Team lead entry point

The primary chat follows this router for natural-language requests, issue triage,
implementation, and self-review with fixes. Specialists follow their assigned roles.
Read `AGENTS.md`, inspect the actual checkout and live issue, and preserve user work.
Use `review-issue` for read-only preparation and issue triage; use `run-issue` for
implementation or corrective work. Select relevant roles, models, and thinking effort
per phase, record decisions, and delegate only when useful. Trivial work may be handled
by the lead. Owner instructions and existing authorization govern the scope.
