import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { applyOverlay, checkHostedAuthConfig, generateLocalWorkdir, parseToml, REPO_ROOT } from './hosted-auth-config.mjs';

const committed = readFileSync(new URL('../../supabase/config.toml', import.meta.url), 'utf8');
const overlay = readFileSync(new URL('../../supabase/config.local.toml', import.meta.url), 'utf8');
const rejected = (text, pattern) => {
  const problems = checkHostedAuthConfig(text);
  assert.ok(problems.length > 0 && (!pattern || problems.some((p) => pattern.test(p))), `expected rejection ${pattern ?? ''}, got ${JSON.stringify(problems)}`);
  return problems;
};

test('safe: the committed config passes', () => assert.deepEqual(checkHostedAuthConfig(committed), []));
test('safe: https site_url and redirect URLs pass', () => {
  assert.deepEqual(checkHostedAuthConfig(committed + '\n[auth]\nsite_url = "https://example.com"\nadditional_redirect_urls = ["https://a.example.com/x"]\n'), []);
});

test('rejects test_otp entries', () => rejected(committed + '\n[auth.sms.test_otp]\n919999900009 = "654321"\n', /test_otp/));
test('rejects CAPTCHA disabled', () => rejected(committed.replace(/(\[auth\.captcha\]\nenabled = )true/, '$1false'), /enabled must be true/));
test('rejects a missing CAPTCHA table', () => rejected(committed.replace(/\[auth\.captcha\][\s\S]*?\n\n/, ''), /enabled must be true/));
test('rejects a literal CAPTCHA secret without echoing it', () => {
  const problems = rejected(committed.replace('env(SUPABASE_AUTH_CAPTCHA_SECRET)', 'literal-secret-value'), /secret must be/);
  assert.ok(!problems.join(' ').includes('literal-secret-value'));
});
test('rejects an enabled send_sms hook', () => rejected(committed.replace('[auth.hook.send_sms]\nenabled = false', '[auth.hook.send_sms]\nenabled = true'), /must be disabled/));
test('rejects any other enabled auth hook', () => rejected(committed + '\n[auth.hook.custom_access_token]\nenabled = true\nuri = "https://x.example.com/h"\n', /custom_access_token/));
test('rejects a trailing text after a value', () => rejected(committed.replace('"env(SUPABASE_AUTH_CAPTCHA_SECRET)"', '"env(SUPABASE_AUTH_CAPTCHA_SECRET)" garbage'), /strict parser/));

test('rejects a multi-line """ string decoy that re-opens [auth.captcha]', () => {
  rejected(committed + '\n[decoy]\nx = """\n[auth.captcha]\nenabled = true\n"""\n[auth.captcha]\nenabled = false\n', /strict parser/);
});
test("rejects a multi-line ''' string decoy that re-opens [auth.captcha]", () => {
  rejected(committed + "\n[decoy]\nx = '''\n[auth.captcha]\nenabled = true\n'''\n[auth.captcha]\nenabled = false\n", /strict parser/);
});
test('rejects [__proto__.captcha] and leaves Object.prototype clean', () => {
  rejected(committed + '\n[__proto__.captcha]\nenabled = true\n', /reserved|strict/);
  rejected(committed + '\n[auth.constructor]\nx = 1\n', /reserved|strict/);
  assert.equal(Object.prototype.captcha, undefined);
  assert.equal({}.enabled, undefined);
});
test("rejects a single-quoted table name [auth.sms.'test_otp']", () => rejected(committed + "\n[auth.sms.'test_otp']\n919999900009 = \"1\"\n", /strict parser/));
test('rejects an inline-table hook under [auth.hook]', () => rejected(committed + '\n[auth.hook]\nsend_sms = { enabled = true, uri = "http://localhost/x" }\n', /strict parser/));
test('rejects [[array tables]]', () => rejected(committed + '\n[[auth.thing]]\nx = 1\n', /strict parser/));
test('rejects dotted keys', () => rejected(committed + '\n[auth]\ncaptcha.enabled = false\n', /strict parser/));
test('rejects duplicate keys and duplicate tables', () => {
  rejected(committed.replace('provider = "turnstile"', 'provider = "turnstile"\nenabled = false'), /strict parser/);
  rejected(committed + '\n[auth.captcha]\nenabled = false\n', /strict parser/);
});

test('rejects a localhost site_url', () => rejected(committed + '\n[auth]\nsite_url = "http://localhost:3000"\n', /site_url/));
test('rejects 127.0.0.1 and host.docker.internal redirect URLs', () => {
  rejected(committed + '\n[auth]\nadditional_redirect_urls = ["https://127.0.0.1/x"]\n', /redirect/);
  rejected(committed + '\n[auth]\nadditional_redirect_urls = ["https://host.docker.internal/x"]\n', /redirect/);
});
test('rejects non-https redirect URLs', () => rejected(committed + '\n[auth]\nadditional_redirect_urls = ["http://app.example.com"]\n', /redirect/));

test('parser keeps the committed values', () => {
  const config = parseToml(committed);
  assert.equal(config.auth.sms.otp_expiry, 600);
  assert.equal(config.functions['send-sms-hook'].verify_jwt, false);
});

test('local overlay yields the fixtures, hook and CAPTCHA off, and fails the hosted check', () => {
  const text = applyOverlay(committed, overlay);
  const merged = parseToml(text);
  assert.deepEqual({ ...merged.auth.sms.test_otp }, { 919999900001: '123456', 919999900002: '123456' });
  assert.equal(merged.auth.captcha.enabled, false);
  assert.equal(merged.auth.captcha.secret, 'env(SUPABASE_AUTH_CAPTCHA_SECRET)');
  assert.equal(merged.auth.hook.send_sms.enabled, true);
  assert.match(merged.auth.hook.send_sms.uri, /^http:\/\/host\.docker\.internal:54321\//);
  assert.equal(merged.auth.sms.otp_expiry, 600);
  assert.ok(text.startsWith('# GENERATED, LOCAL ONLY. Do not link or push this workdir.\n'));
  assert.ok(!/\n\n\n/.test(text), 'no stray blank lines');
  assert.ok(checkHostedAuthConfig(text).length >= 3);
});

test('generateLocalWorkdir writes the merged config and always links .env.local', () => {
  const root = mkdtempSync(join(tmpdir(), 'cfg-'));
  mkdirSync(join(root, 'supabase/migrations'), { recursive: true });
  for (const [file, text] of [['config.toml', committed], ['config.local.toml', overlay]]) writeFileSync(join(root, 'supabase', file), text);
  const target = generateLocalWorkdir({ root });
  assert.equal(parseToml(readFileSync(join(target, 'config.toml'), 'utf8')).auth.sms.test_otp['919999900001'], '123456');
  assert.ok(existsSync(join(target, 'migrations')));
  assert.ok(lstatSync(join(target, '.env.local')).isSymbolicLink(), 'dangling .env.local link is created');
  assert.deepEqual(checkHostedAuthConfig(readFileSync(join(root, 'supabase/config.toml'), 'utf8')), []);
});

test('the CLI exits 1 on an unsafe file and 0 on the committed one, from any cwd', () => {
  const script = join(REPO_ROOT, '.github/scripts/hosted-auth-config.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'cli-'));
  const bad = join(dir, 'config.toml');
  writeFileSync(bad, committed.replace(/(\[auth\.captcha\]\nenabled = )true/, '$1false'));
  assert.throws(() => execFileSync(process.execPath, [script, 'check', bad], { cwd: dir, stdio: 'pipe' }), (e) => e.status === 1);
  assert.match(execFileSync(process.execPath, [script, 'check'], { cwd: dir, encoding: 'utf8' }), /production-safe/);
});
