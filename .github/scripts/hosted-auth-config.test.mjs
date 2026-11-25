import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readFileSync as read, mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyOverlay, checkHostedAuthConfig, generateLocalWorkdir, parseToml } from './hosted-auth-config.mjs';

const committed = readFileSync(new URL('../../supabase/config.toml', import.meta.url), 'utf8');
const overlay = readFileSync(new URL('../../supabase/config.local.toml', import.meta.url), 'utf8');

test('the committed config is production-safe', () => assert.deepEqual(checkHostedAuthConfig(committed), []));

test('unsafe committed config is rejected without echoing values', () => {
  const cases = [
    [committed + '\n[auth.sms.test_otp]\n919999900009 = "654321"\n', /test_otp/],
    [committed.replace(/(\[auth\.captcha\]\nenabled = )true/, '$1false'), /captcha\] enabled/],
    [committed.replace('env(SUPABASE_AUTH_CAPTCHA_SECRET)', 'literal-secret-value'), /secret must be/],
    [committed.replace(/uri = "[^"]*"/, 'uri = "http://host.docker.internal:54321/functions/v1/send-sms-hook"'), /https|local/],
    [committed.replace(/uri = "[^"]*"/, 'uri = "https://127.0.0.1/functions/v1/send-sms-hook"'), /local address/],
    [committed.replace(/uri = "[^"]*"/, 'uri = "https://localhost/hook"'), /local address/],
  ];
  for (const [text, pattern] of cases) {
    const problems = checkHostedAuthConfig(text);
    assert.ok(problems.some((p) => pattern.test(p)), `${pattern} not reported: ${problems}`);
    assert.ok(!problems.join(' ').includes('literal-secret-value') && !problems.join(' ').includes('654321'));
  }
});

test('missing captcha table is rejected', () => {
  assert.ok(checkHostedAuthConfig(committed.replace(/\[auth\.captcha\][\s\S]*?\n\n/, '')).length > 0);
});

test('the local overlay yields the fixtures and keeps the rest', () => {
  const merged = parseToml(applyOverlay(committed, overlay));
  assert.deepEqual(merged.auth.sms.test_otp, { 919999900001: '123456', 919999900002: '123456' });
  assert.equal(merged.auth.captcha.enabled, false);
  assert.equal(merged.auth.captcha.secret, 'env(SUPABASE_AUTH_CAPTCHA_SECRET)');
  assert.match(merged.auth.hook.send_sms.uri, /^http:\/\/host\.docker\.internal:54321\//);
  assert.equal(merged.auth.sms.otp_expiry, 600);
  assert.equal(merged.functions['send-sms-hook'].verify_jwt, false);
  assert.ok(checkHostedAuthConfig(applyOverlay(committed, overlay)).length >= 3, 'merged local config must fail the hosted check');
  assert.deepEqual(checkHostedAuthConfig(committed), [], 'the committed file is unchanged by merging');
});

test('generateLocalWorkdir writes a merged config and links project files', () => {
  const root = mkdtempSync(join(tmpdir(), 'cfg-'));
  mkdirSync(join(root, 'supabase/migrations'), { recursive: true });
  writeFileSync(join(root, 'supabase/config.toml'), committed);
  writeFileSync(join(root, 'supabase/config.local.toml'), overlay);
  const target = generateLocalWorkdir({ root });
  assert.equal(parseToml(read(join(target, 'config.toml'), 'utf8')).auth.sms.test_otp['919999900001'], '123456');
  assert.ok(existsSync(join(target, 'migrations')));
  assert.deepEqual(checkHostedAuthConfig(read(join(root, 'supabase/config.toml'), 'utf8')), []);
});
