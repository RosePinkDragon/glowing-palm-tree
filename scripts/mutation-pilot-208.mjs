#!/usr/bin/env node
// Bounded, local-only mutation pilot. It never changes the calling checkout.
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const run = (cmd, args, cwd, timeout = 120000) => {
  const start = Date.now();
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, CI: '1' } });
  return { status: r.status, signal: r.signal, error: r.error?.code, output: (r.stdout ?? '') + (r.stderr ?? ''), ms: Date.now() - start };
};
const must = (cmd, args, cwd, timeout) => { const r = run(cmd, args, cwd, timeout); if (r.status !== 0) throw new Error(`${cmd} failed: ${r.error ?? ''}\n${r.output}`); return r; };
const revision = process.argv[2] ?? 'HEAD';
const sha = must('git', ['rev-parse', '--verify', `${revision}^{commit}`], repo).output.trim();
const started = Date.now();
const temp = mkdtempSync(join(tmpdir(), 'mutation-pilot-208-'));
const checkout = join(temp, 'checkout');
const tests = {
  cart: ['packages/core/src/domain.test.ts', 'cart is immutable'],
  identity: ['packages/services/src/customer-orders.test.ts', 'in-flight customer reads reject'],
  auth: ['packages/services/src/customer-orders.test.ts', 'customer APIs fail closed'],
  offer: ['packages/services/src/offers.test.ts', 'revised pricing keeps'],
};
const ranges = { cart: [31, 49], identity: [190, 207], auth: [173, 189], offer: [50, 64] };
const mutations = [
  { id: 'cart-subtotal', test: 'cart', file: 'packages/core/src/domain.ts', from: 'subtotal += lineTotal;', to: 'subtotal += item.pricePaise;' },
  { id: 'identity-generation', test: 'identity', file: 'packages/services/src/index.ts', from: 'disposed || generation !== started || (userId !== undefined && sessionUserId !== undefined && sessionUserId !== userId)', to: 'disposed || (userId !== undefined && sessionUserId !== undefined && sessionUserId !== userId)' },
  { id: 'customer-audience', test: 'auth', file: 'packages/services/src/index.ts', from: "if (audience !== 'customer') throw new ServiceError('CUSTOMER_REQUIRED', 'Use the customer app to view your order history.');", to: "if (false) throw new ServiceError('CUSTOMER_REQUIRED', 'Use the customer app to view your order history.');" },
  { id: 'offer-total', test: 'offer', file: 'packages/services/src/index.ts', from: 'q.total_paise !== subtotal + q.delivery_fee_paise - discount', to: 'false' },
];
function test(name) {
  const [file, pattern] = tests[name];
  return run(process.execPath, ['--import', './packages/services/src/test-loader.mjs', '--test', '--test-isolation=none', '--test-reporter=tap', `--test-name-pattern=${pattern}`, file], checkout);
}
function replaceExactly(file, from, to) {
  const path = join(checkout, file), original = readFileSync(path, 'utf8');
  if (original.split(from).length !== 2) throw new Error(`mutation anchor not unique: ${file}`);
  writeFileSync(path, original.replace(from, to)); return () => writeFileSync(path, original);
}
try {
  must('git', ['clone', '--quiet', '--shared', '--no-checkout', repo, checkout], temp);
  must('git', ['checkout', '--quiet', '--detach', sha], checkout);
  must('npm', ['ci', '--workspace', '@market/core', '--workspace', '@market/services', '--omit=optional', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', join(temp, 'npm-cache')], checkout, 300000);
  const baseline = {};
  for (const name of Object.keys(tests)) { const r = test(name); baseline[name] = { status: r.status, ms: r.ms }; if (r.status !== 0 || !/# tests 1\b/.test(r.output) || !/# pass 1\b/.test(r.output)) throw new Error(`baseline ${name} failed or did not run: ${r.output}`); }
  // Negative control: an unrelated production module changes while every targeted test still passes.
  const restoreControl = replaceExactly('packages/core/src/otp.ts', 'export const OTP_LENGTH = 6;', 'export const OTP_LENGTH = 7;');
  const control = Object.fromEntries(Object.keys(tests).map(name => { const r = test(name); return [name, { status: r.status === 0 && /# pass 1\b/.test(r.output) ? 0 : 1, ms: r.ms, output: r.status === 0 ? undefined : r.output }]; }));
  restoreControl();
  if (Object.values(control).some(r => r.status !== 0)) throw new Error(`unrelated control failed: ${JSON.stringify(control)}`);
  const results = [];
  for (const mutant of mutations) {
    const restore = replaceExactly(mutant.file, mutant.from, mutant.to);
    let r;
    try { r = test(mutant.test); } finally { restore(); }
    const stack = r.output.split('  stack: |-').at(-1) ?? '';
    const escaped = tests[mutant.test][0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const line = Number(new RegExp(escaped + ':(\\d+):\\d+').exec(stack)?.[1]);
    const [first, last] = ranges[mutant.test];
    const category = r.error === 'ETIMEDOUT' ? 'timeout' : /# tests 0\b/.test(r.output) ? 'uncovered' : r.status === 0 && /# tests 1\b/.test(r.output) && /# pass 1\b/.test(r.output) ? 'survived' : r.status !== null && r.status !== 0 && /# tests 1\b/.test(r.output) && /# fail 1\b/.test(r.output) && /code: 'ERR_ASSERTION'/.test(r.output) && /failureType: 'testCodeFailure'/.test(r.output) && line >= first && line <= last && !/SyntaxError|ERR_MODULE_NOT_FOUND/.test(r.output) ? 'assertion-killed' : 'setup-or-other-failure';
    results.push({ id: mutant.id, file: mutant.file, test: tests[mutant.test][0], category, ms: r.ms, output: r.status === 0 ? undefined : r.output });
  }
  console.log(JSON.stringify({ revision: sha, node: process.version, elapsedMs: Date.now() - started, baseline, control, results }, null, 2));
  if (results.some(r => r.category === 'setup-or-other-failure' || r.category === 'timeout' || r.category === 'uncovered')) process.exitCode = 1;
} finally { rmSync(temp, { recursive: true, force: true }); }
