import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate } from './validate-codex.mjs';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'codex-validation-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const path of ['.codex', '.agents', '.github/workflows', 'docs', 'AGENTS.md']) {
    cpSync(join(source, path), join(root, path), { recursive: true });
  }
  return root;
}
const put = (root, path, content) => writeFileSync(join(root, path), content);

test('valid checkout and repeated calls do not share errors', t => {
  const root = fixture(t);
  assert.deepEqual(validate(root), []);
  const original = readFileSync(join(root, '.codex/config.toml'), 'utf8');
  put(root, '.codex/config.toml', '[agents\n');
  assert.notEqual(validate(root).length, 0);
  put(root, '.codex/config.toml', original);
  assert.deepEqual(validate(root), []);
});

test('invalid config or role definitions are rejected', t => {
  const root = fixture(t);
  const config = readFileSync(join(root, '.codex/config.toml'), 'utf8');
  for (const bad of ['model = "x"\n' + config, config + '\nmodel_reasoning_effort = "high"\n', config + '\nenabld = true\n', '[agents\n']) {
    put(root, '.codex/config.toml', bad);
    assert.notEqual(validate(root).length, 0, bad);
  }
  put(root, '.codex/config.toml', config);
  const path = '.codex/agents/ba.toml';
  const role = readFileSync(join(root, path), 'utf8');
  for (const bad of ['name = "ba"\n', 'name = [\n', role.replace('name = "ba"', 'name = "wrong"'), role + '\nmodel = "x"\n', role + '\nmodel_reasoning_effort = "high"\n']) {
    put(root, path, bad);
    assert.notEqual(validate(root).length, 0, bad);
  }
  rmSync(join(root, path));
  assert.notEqual(validate(root).length, 0);
});

test('front matter requires bounded, unique string fields and a body', t => {
  const root = fixture(t);
  const path = '.agents/skills/team-lead/SKILL.md';
  const good = '---\nname: team-lead\ndescription: "Useful: skill"\n---\n# Body\n';
  put(root, path, good);
  assert.deepEqual(validate(root), []);
  for (const bad of [good.replace('"Useful: skill"', '""'), good.replace('team-lead', 'wrong'), good.replace('\n---\n# Body', '\n# Body'), good.replace('# Body', ' '), good.replace('description:', 'descripton:'), good.replace('description: "Useful: skill"', 'description: x\ndescription: y'), good.replace('"Useful: skill"', '123'), good.replace('description: "Useful: skill"', 'description: *alias'), good.replace('description: "Useful: skill"', 'description: [a, b]'), good.replace('"Useful: skill"', '"unterminated')]) {
    put(root, path, bad);
    assert.notEqual(validate(root).length, 0, bad);
  }
  for (const value of ['ignored', 'null']) {
    put(root, path, good.replace('description: "Useful: skill"', `description: "Useful: skill"\n__proto__: ${value}`));
    assert.notEqual(validate(root).length, 0, `__proto__: ${value}`);
  }
});
