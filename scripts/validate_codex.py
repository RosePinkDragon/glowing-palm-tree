#!/usr/bin/env python3
"""Validate this repository's deliberately limited Codex configuration subset."""

import json
from pathlib import Path
import re
import sys
import tomllib

ROOT = Path(__file__).resolve().parent.parent
ROLES = {"ba", "developer", "ui_ux_reviewer", "senior_developer"}
SKILLS = {"team-lead", "expo-foundation", "four-app-config", "release-checks"}


def validate(root: Path) -> list[str]:
    """Return independent structural errors for a checkout; do not mutate it."""
    root = Path(root)
    errors: list[str] = []

    def read(relative: str) -> str:
        try:
            return (root / relative).read_text(encoding="utf-8")
        except (OSError, UnicodeError) as exc:
            errors.append(f"{relative}: {exc}")
            return ""

    def toml(relative: str) -> dict:
        try:
            return tomllib.loads((root / relative).read_text(encoding="utf-8"))
        except (OSError, UnicodeError, tomllib.TOMLDecodeError) as exc:
            errors.append(f"{relative}: {exc}")
            return {}

    def keys(obj: dict, allowed: set[str], label: str) -> None:
        extra = set(obj) - allowed
        if extra:
            errors.append(f"{label}: unsupported keys {sorted(extra)}")

    config = toml('.codex/config.toml')
    keys(config, {'agents'}, 'config')
    agents = config.get('agents')
    if not isinstance(agents, dict):
        errors.append('config: agents must be a table')
        agents = {}
    keys(agents, {'enabled', 'max_concurrent_threads_per_session'}, 'agents')
    if agents.get('enabled') is not True:
        errors.append('agents.enabled must be true')
    if type(agents.get('max_concurrent_threads_per_session')) is not int or agents.get('max_concurrent_threads_per_session') != 4:
        errors.append('agents.max_concurrent_threads_per_session must be 4')

    found = {path.stem for path in (root / '.codex/agents').glob('*.toml')}
    if found != ROLES:
        errors.append(f'role files must be {sorted(ROLES)}; got {sorted(found)}')
    for role in sorted(ROLES):
        definition = toml(f'.codex/agents/{role}.toml')
        keys(definition, {'name', 'description', 'developer_instructions'}, role)
        if definition.get('name') != role:
            errors.append(f'{role}: name must match role')
        for field in ('description', 'developer_instructions'):
            value = definition.get(field)
            if not isinstance(value, str) or not value.strip():
                errors.append(f'{role}: {field} is required')

    for skill in sorted(SKILLS):
        path = f'.agents/skills/{skill}/SKILL.md'
        lines = read(path).splitlines()
        if not lines or lines[0] != '---' or '---' not in lines[1:]:
            errors.append(f'{skill}: bounded front matter is required')
            continue
        end = lines.index('---', 1)
        fields: dict[str, str] = {}
        for line in lines[1:end]:
            match = re.fullmatch(r'(name|description):[ \t]*(.*)', line)
            if not match or match.group(1) in fields:
                errors.append(f'{skill}: invalid or duplicate front matter field')
                continue
            key, value = match.groups()
            value = value.strip()
            try:
                if value.startswith('"'):
                    value = json.loads(value)
                elif value.startswith("'"):
                    if len(value) < 2 or not value.endswith("'"):
                        raise ValueError('unterminated quoted value')
                    inner = value[1:-1]
                    if re.search(r"(?<!')'(?!')", inner):
                        raise ValueError('invalid single quote')
                    value = inner.replace("''", "'")
                elif (not value or re.search(r':(?:\s|$)|\s#|^[#\[\]{}&*!|>@`%?,-]', value)
                      or value.lower() in {'null', 'true', 'false', '~'}
                      or re.fullmatch(r'[+-]?(?:[0-9][0-9_.]*|\.[0-9_]+)(?:[eE][+-]?[0-9]+)?', value)):
                    raise ValueError('unsupported plain value')
                if not isinstance(value, str) or not value.strip():
                    raise ValueError('empty value')
                fields[key] = value
            except (ValueError, json.JSONDecodeError):
                errors.append(f'{skill}: {key} must be a nonempty single-line string')
        if set(fields) != {'name', 'description'} or fields.get('name') != skill:
            errors.append(f'{skill}: matching name and description are required')
        if not '\n'.join(lines[end + 1:]).strip():
            errors.append(f'{skill}: body is required')

    for path in ('AGENTS.md', 'docs/CODEX.md', '.github/workflows/codex-checks.yml'):
        if not read(path).strip():
            errors.append(f'{path}: file must not be empty')
    return errors


def main() -> int:
    errors = validate(ROOT)
    if errors:
        print('Codex validation failed:', file=sys.stderr)
        for error in errors:
            print(f'- {error}', file=sys.stderr)
        return 1
    print('Codex configuration and required files are valid.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
