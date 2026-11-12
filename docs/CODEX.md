# Codex team setup

The primary chat follows the mandatory `.agents/skills/team-lead/SKILL.md` router for
natural-language issue work, triage, and self-review with fixes. It selects roles, models,
and thinking effort per phase; not every role is needed for every task. The repository
configures up to four concurrent agent threads and provides standalone `ba`, `developer`,
`ui_ux_reviewer`, and `senior_developer` role definitions in `.codex/agents/` without
fixed model or reasoning effort. Follow `AGENTS.md` for the approval, branch, file-budget,
and owner-review rules. Inspect the live issue, labels, and actual checkout for each task.

Specialists inherit session permissions; review instructions are behavioral boundaries,
not operating-system sandboxes. If the runtime cannot select a custom role, the lead may
load its instructions into an explicit handoff and disclose the fallback; do not claim
the configured role was used. The lead owns PR updates and collects independent reviews.
Use `/skills` in a compatible Codex session from a trusted project directory to inspect
skill discovery or invoke `$team-lead`; confirm the runtime role when delegating. These
manual checks are separate from syntax validation and do not prove review quality.

The routing, role modes, short briefs, and risk-based reviews were adapted from
[fuzzy-waddle's Claude setup](https://github.com/RosePinkDragon/fuzzy-waddle/tree/98b68f1c0467ab3e34e9a163a54157ea977fa5d7/.claude).
This repository's owner instructions override that reference: in particular, the exact
`approved` feature gate, bug rule, branch names, file-count exclusions, role selection,
and PR ownership here govern. No reference-specific labels or standing authorizations
are imported. Load only relevant sections of `.codex/reference/project-context.md`.

With Node 24, run `npm ci --ignore-scripts`, `npm run check:codex`, and
`npm run test:codex`. The read-only CI workflow runs these commands on pushes and pull
requests. The TOML and YAML parser-based validator checks syntax and the supported
configuration structure, required roles, skill metadata and bodies, and context file.
It rejects unknown configuration keys, fixed models, duplicate metadata keys, aliases,
and non-string metadata. It does not establish runtime discovery or issue approval.
