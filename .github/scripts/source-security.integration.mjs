import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const scanner = fileURLToPath(new URL('source-security.mjs', import.meta.url));
const requireCi = fileURLToPath(new URL('require-ci.sh', import.meta.url));

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'source-security-test-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  return cwd;
}

function run(cwd, command, args, env = {}) {
  return spawnSync(command, args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 120_000 });
}

function testSecrets(t) {
  const cwd = fixture(t);
  const git = (...args) => {
    const result = run(cwd, 'git', args);
    assert.equal(result.status, 0, `git ${args[0]} failed in the test fixture`);
    return result.stdout.trim();
  };
  git('init', '-q');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Security test');
  git('commit', '--allow-empty', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  const scan = (event, head, from = base) =>
    run(cwd, process.execPath, [scanner, 'secrets'], { GITHUB_EVENT_NAME: event, SCAN_HEAD: head, SCAN_BASE: from });

  mkdirSync(join(cwd, 'docs'));
  writeFileSync(join(cwd, 'docs/example.md'), 'Harmless documentation.\n');
  git('add', 'docs/example.md');
  git('commit', '-qm', 'clean docs');
  assert.equal(scan('pull_request', git('rev-parse', 'HEAD')).status, 0);

  // Assembled at runtime so this integration test does not add a token-shaped string to Git.
  const synthetic = ['ghp', '_', '0aB9wZ1xQ8pL2oK7sE3iU6rT4yH5mN0dF9jG'].join('');
  writeFileSync(join(cwd, 'docs/example.md'), `Fixture token: ${synthetic}\n`);
  git('commit', '-qam', 'add fixture');
  git('rm', '-q', 'docs/example.md');
  git('commit', '-qm', 'remove fixture');
  const head = git('rev-parse', 'HEAD');
  const files = () => readdirSync(cwd, { recursive: true }).filter(file => !file.startsWith('.git')).sort();
  const before = files();

  for (const event of ['pull_request', 'push', 'workflow_dispatch']) {
    const result = scan(event, head);
    assert.equal(result.status, 1, `secret scan should fail on ${event}`);
    assert.ok(!(result.stdout + result.stderr).includes(synthetic), 'scanner output must omit the value');
    assert.match(result.stderr, /^Secret scan detected potential credentials\./);

    const needed = { changes: { result: 'success' }, 'source-security': { result: 'failure' } };
    const gate = run(cwd, 'bash', [requireCi], {
      NEEDS: JSON.stringify(needed), APP: 'false', BROWSER: 'false', DB: 'false', FUNCTIONS: 'false', SCRIPTS: 'false',
    });
    assert.equal(gate.status, 1, 'the actual ci gate must fail');
    assert.ok(!(gate.stdout + gate.stderr).includes(synthetic), 'the ci gate output must omit the value');
    assert.match(gate.stderr, /Not passing: source-security/);
  }
  assert.deepEqual(files(), before, 'no report or artifact may be created');
}

function testStatic(t) {
  const cwd = fixture(t);
  for (const path of ['.github/scripts', 'packages/services', 'supabase/functions']) mkdirSync(join(cwd, path), { recursive: true });
  const path = join(cwd, 'supabase/functions/example.ts');
  const scan = () => run(cwd, process.execPath, [scanner, 'static']);
  writeFileSync(path, 'const options = { shell: true };\n');
  const warning = scan();
  assert.equal(warning.status, 0);
  assert.match(warning.stdout, /with 0 blocking and 1 report-only findings/);

  writeFileSync(path, 'eval(source);\nconst options = { rejectUnauthorized: false };\n');
  const blocked = scan();
  assert.equal(blocked.status, 1);
  assert.match(blocked.stdout, /with 2 blocking and 0 report-only findings/);
  assert.match(blocked.stderr, /found blocking patterns/);
}

const suites = new Map([
  ['secrets', ['secret scan rejects a synthetic finding removed before the PR tip without leaking it', testSecrets]],
  ['static', ['static analysis reports shell options and blocks eval and disabled TLS verification', testStatic]],
]);
const args = process.argv.slice(2);
if (args.length !== 1 || !suites.has(args[0])) {
  console.error('Select exactly one source-security test suite: secrets or static.');
  process.exitCode = 1;
} else {
  test(...suites.get(args[0]));
}
