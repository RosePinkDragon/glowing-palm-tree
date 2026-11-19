import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { MODES } from './migration-policy.mjs';
import { validateMigrationPolicyFile } from './validate-migration-policy.mjs';

const checkedInTest = 'checked-in migration policy is valid';
test(checkedInTest, () => {
  validateMigrationPolicyFile();
});

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'checked-in-migration-policy-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, file: join(root, 'policy.json') };
}

test('file validation accepts every known mode and rejects invalid JSON, shapes and modes', t => {
  const { file } = fixture(t);
  for (const mode of MODES) {
    writeFileSync(file, JSON.stringify({ mode, baseline: mode === 'frozen' ? { version: '20261117000000', commit: 'c'.repeat(40) } : null }));
    assert.equal(validateMigrationPolicyFile(file).mode, mode);
  }
  for (const text of ['{"mode":"bogus"}', '{', '[]', 'null', 'true', '"frozen"', '{}', '{"mode":null}']) {
    writeFileSync(file, text);
    assert.throws(() => validateMigrationPolicyFile(file), /valid JSON|known mode/);
  }
  assert.throws(() => validateMigrationPolicyFile(file + '.missing'), /readable, valid JSON/);
});

test('frozen mode requires a baseline version and commit', t => {
  const { file } = fixture(t);
  const good = { version: '20261117000000', commit: 'c'.repeat(40) };
  for (const baseline of [undefined, null, [], 'x', {}, { version: good.version }, { commit: good.commit }, { ...good, version: '2026' }, { ...good, commit: 'C'.repeat(40) }, { ...good, commit: 'abc123' }]) {
    writeFileSync(file, JSON.stringify({ mode: 'frozen', baseline }));
    assert.throws(() => validateMigrationPolicyFile(file), /frozen mode requires baseline/);
  }
  writeFileSync(file, JSON.stringify({ mode: 'frozen', baseline: good }));
  assert.deepEqual(validateMigrationPolicyFile(file).baseline, good);
});

test('the App CI checked-in-file test actually fails for an invalid proposed checkout', t => {
  const { root } = fixture(t);
  const scripts = join(root, '.github', 'scripts');
  mkdirSync(scripts, { recursive: true });
  mkdirSync(join(root, 'supabase'));
  for (const name of ['migration-policy.mjs', 'validate-migration-policy.mjs', 'validate-migration-policy.test.mjs']) {
    copyFileSync(fileURLToPath(new URL(name, import.meta.url)), join(scripts, name));
  }
  for (const text of ['{"mode":"bogus"}', '{', '[]']) {
    writeFileSync(join(root, 'supabase', 'migration-policy.json'), text);
    const result = spawnSync(process.execPath, ['--test', '--test-isolation=none', `--test-name-pattern=^${checkedInTest}$`, join(scripts, 'validate-migration-policy.test.mjs')], { cwd: root, encoding: 'utf8' });
    assert.ifError(result.error);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /valid JSON|known mode/);
  }
});
