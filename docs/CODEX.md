# Codex team setup

Codex reads the repository instructions in `AGENTS.md`. The current chat acts as the
team lead, selecting appropriate roles, models, and thinking effort for the task. The
repository enables multi-agent work with up to four concurrent agent threads and
discovers four standalone roles in `.codex/agents/`: `ba`, `developer`,
`ui_ux_reviewer`, and `senior_developer`. No model or reasoning effort is fixed in the
role files. A lead can handle trivial work directly and should delegate only where useful.

Start with the issue and follow the approval, branch, handoff, review, and file-count
rules in `AGENTS.md` and `.agents/skills/team-lead/SKILL.md`. Inspect the checkout,
live issue, and current labels for each task; the task skills do not assume any app or
infrastructure exists. Specialist roles inherit the session permissions; their review
instructions are behavioral boundaries, not operating-system sandboxes. If a runtime
cannot select a custom role, the lead may load its instructions into an explicit
handoff and disclose the fallback; do not claim the configured role was used.

Use a compatible Codex version from the repository directory and trust the project
when Codex prompts. Use `/skills` to inspect skill discovery, or invoke `$team-lead`
explicitly. Confirm the role selected by the runtime when delegating. Agent review
results are evidence for the lead; they are not GitHub owner approvals.

Run `python3 scripts/validate_codex.py` with Python 3.11 or newer to check the
configuration and required files. The `Codex checks` workflow runs this same check on
pushes and pull requests. It uses read-only repository permissions and no secrets.
The validator checks structure, not whether an issue is approved or a review is sound.

Run `python3 -m unittest discover -s tests` for validator regression tests. The
validator intentionally accepts only this repository's configuration subset: the
`agents` table with its two configured keys and role files with `name`, `description`,
and `developer_instructions`. It rejects other keys, including fixed models, so update
the validator deliberately when extending the configuration. Skill front matter must
be bounded by `---` lines with exactly one `name` and one `description`, each on one
line as a nonempty plain string, JSON-style double-quoted string, or YAML-style
single-quoted string (doubled apostrophes escape an apostrophe). Plain strings exclude
YAML collection or directive indicators, inline comments, colon-space, and scalar
forms for numbers, booleans, or null. A nonempty
body must follow. This is not a general YAML parser. Validation checks file structure,
not runtime role discovery, issue approval, or review quality.
