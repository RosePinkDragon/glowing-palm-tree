# Codex team setup

Codex reads the repository instructions in `AGENTS.md`. The current chat acts as the
team lead, selecting appropriate roles, models, and thinking effort for the task. The
repository enables multi-agent work with up to four concurrent agent threads and
discovers four standalone roles in `.codex/agents/`: `ba`, `developer`,
`ui_ux_reviewer`, and `senior_developer`. No
model or reasoning effort is fixed in the role files. A lead can handle trivial work
directly and should delegate only where useful.

Start with the issue and follow the approval, branch, handoff, review, and file-count
rules in `AGENTS.md` and `.agents/skills/team-lead/SKILL.md`. Issue #1 remains pending
and unapproved. The Expo, four-app configuration, and release skills are guidance for
future authorized work; they do not imply that the monorepo or apps already exist.

Run `python3 scripts/validate_codex.py` with Python 3.11 or newer to check the
configuration and required files. The `Codex checks` workflow runs this same check on
pushes and pull requests. It uses read-only repository permissions and no secrets.
The validator checks structure, not whether an issue is approved or a review is sound.
