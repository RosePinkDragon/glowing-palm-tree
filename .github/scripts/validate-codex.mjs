#!/usr/bin/env node
// Structural validation of this repository's Codex configuration, not runtime discovery.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseToml } from 'smol-toml';
import { isAlias, isMap, isScalar, parseDocument } from 'yaml';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ROLES = ['ba', 'developer', 'senior_developer', 'ui_ux_reviewer'];
const SKILLS = ['review-issue', 'run-issue', 'team-lead'];
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;

export function validate(root) {
  const errors = [];
  function read(path) {
    try { return readFileSync(join(root, path), 'utf8'); }
    catch (error) { errors.push(`${path}: ${error.message}`); return ''; }
  }
  function toml(path) {
    try { return parseToml(read(path)); }
    catch (error) { errors.push(`${path}: invalid TOML: ${error.message}`); return {}; }
  }
  function keys(object, allowed, label) {
    for (const key of Object.keys(object)) {
      if (!allowed.includes(key)) errors.push(`${label}: unsupported key ${key}`);
    }
  }
  const config = toml('.codex/config.toml');
  keys(config, ['agents'], 'config');
  const agents = isObject(config.agents) ? config.agents : {};
  if (!isObject(config.agents)) errors.push('config: agents table required');
  keys(agents, ['enabled', 'max_concurrent_threads_per_session'], 'agents');
  if (agents.enabled !== true) errors.push('agents.enabled must be true');
  if (agents.max_concurrent_threads_per_session !== 4) errors.push('agents.max_concurrent_threads_per_session must be 4');
  let found = [];
  try { found = readdirSync(join(root, '.codex/agents')).filter(name => name.endsWith('.toml')).map(name => name.slice(0, -5)).sort(); }
  catch (error) { errors.push(`role directory: ${error.message}`); }
  if (JSON.stringify(found) !== JSON.stringify(ROLES)) errors.push('role files do not match required roles');
  for (const role of ROLES) {
    const definition = toml(`.codex/agents/${role}.toml`);
    keys(definition, ['name', 'description', 'developer_instructions'], role);
    if (definition.name !== role) errors.push(`${role}: name must match role`);
    for (const field of ['description', 'developer_instructions']) {
      if (!nonempty(definition[field])) errors.push(`${role}: ${field} is required`);
    }
  }
  for (const skill of SKILLS) {
    const content = read(`.agents/skills/${skill}/SKILL.md`);
    const lines = content.split(/\r?\n/);
    const end = lines.indexOf('---', 1);
    if (lines[0] !== '---' || end < 0) {
      errors.push(`${skill}: bounded front matter required`);
      continue;
    }
    const doc = parseDocument(lines.slice(1, end).join('\n'), { uniqueKeys: true });
    if (doc.errors.length || !isMap(doc.contents)) {
      errors.push(`${skill}: invalid front matter`);
      continue;
    }
    const fields = Object.create(null);
    for (const pair of doc.contents.items) {
      if (!isScalar(pair.key) || typeof pair.key.value !== 'string' || isAlias(pair.value) || !isScalar(pair.value)) {
        errors.push(`${skill}: fields must be direct strings without aliases`);
        continue;
      }
      fields[pair.key.value] = pair.value.value;
    }
    keys(fields, ['name', 'description'], skill);
    if (fields.name !== skill) errors.push(`${skill}: name must match skill`);
    if (!nonempty(fields.description)) errors.push(`${skill}: description is required`);
    if (!lines.slice(end + 1).join('\n').trim()) errors.push(`${skill}: body is required`);
  }
  for (const path of ['AGENTS.md', 'docs/CODEX.md', '.codex/reference/project-context.md', '.github/workflows/codex-checks.yml']) {
    if (!read(path).trim()) errors.push(`${path}: file must not be empty`);
  }
  return errors;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const errors = validate(ROOT);
  if (errors.length) {
    console.error(`Codex validation failed:\n${errors.map(error => `- ${error}`).join('\n')}`);
    process.exitCode = 1;
  } else console.log('Codex configuration and required files are valid.');
}
