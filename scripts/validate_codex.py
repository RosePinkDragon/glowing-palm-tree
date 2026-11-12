#!/usr/bin/env python3
"""Check the repository's Codex team configuration using only Python 3.11+."""

from pathlib import Path
import sys
import tomllib

ROOT = Path(__file__).resolve().parent.parent
ROLES = {"ba", "developer", "ui_ux_reviewer", "senior_developer"}
SKILLS = {"team-lead", "expo-foundation", "four-app-config", "release-checks"}
errors: list[str] = []


def read(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as exc:
        errors.append(f"{path.relative_to(ROOT)}: {exc}")
        return ""


def toml(path: Path) -> dict:
    try:
        with path.open("rb") as stream:
            return tomllib.load(stream)
    except (OSError, tomllib.TOMLDecodeError) as exc:
        errors.append(f"{path.relative_to(ROOT)}: {exc}")
        return {}


def nonempty(value: object) -> bool:
    return isinstance(value, str) and bool(value.strip())


def main() -> int:
    config = toml(ROOT / ".codex/config.toml")
    agents = config.get("agents", {})
    if not isinstance(agents, dict):
        errors.append("agents must be a table")
        agents = {}
    if agents.get("enabled") is not True:
        errors.append("agents.enabled must be true")
    if agents.get("max_concurrent_threads_per_session") != 4:
        errors.append("agents.max_concurrent_threads_per_session must be 4")
    found = {path.stem for path in (ROOT / ".codex/agents").glob("*.toml")}
    if found != ROLES:
        errors.append(f"role files must be {sorted(ROLES)}; got {sorted(found)}")
    for role in sorted(ROLES):
        expected = f"agents/{role}.toml"
        definition = toml(ROOT / ".codex" / expected)
        if definition.get("name") != role:
            errors.append(f"{role}: name must match role")
        for field in ("description", "developer_instructions"):
            if not nonempty(definition.get(field)):
                errors.append(f"{role}: {field} is required")
        for field in ("model", "model_reasoning_effort"):
            if field in definition:
                errors.append(f"{role}: {field} must not be fixed")
    for skill in sorted(SKILLS):
        content = read(ROOT / ".agents/skills" / skill / "SKILL.md")
        if not content.startswith(f"---\nname: {skill}\n") or "\ndescription: " not in content or "\n---\n" not in content[4:]:
            errors.append(f"{skill}: skill front matter requires matching name and description")
    for path in ("AGENTS.md", "docs/CODEX.md", ".github/workflows/codex-checks.yml"):
        if not read(ROOT / path).strip():
            errors.append(f"{path}: file must not be empty")
    if errors:
        print("Codex validation failed:", file=sys.stderr)
        for error in errors:
            print(f"- {error}", file=sys.stderr)
        return 1
    print("Codex configuration and required files are valid.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
