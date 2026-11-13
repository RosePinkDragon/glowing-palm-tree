import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { appKeys, exportWeb } from './export-web.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'market-web-export-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const appKey = appKeys[0];
  const appDirectory = join(root, 'apps', appKey);
  const notificationsDirectory = join(root, 'packages', 'notifications');
  mkdirSync(appDirectory, { recursive: true });
  mkdirSync(notificationsDirectory, { recursive: true });
  writeFileSync(join(appDirectory, 'package.json'), JSON.stringify({ name: appKey }));
  writeFileSync(join(notificationsDirectory, 'package.json'), JSON.stringify({
    name: '@market/notifications',
    scripts: { 'build:worker': 'esbuild src/worker.ts --bundle' },
  }));
  return { appKey, appDirectory, notificationsDirectory, root };
}

test('fixed app export runs Expo first and bundles the public Firebase worker beside the web entry', (t) => {
  const { appKey, appDirectory, notificationsDirectory, root } = fixture(t);
  const calls = [];
  const workerOutput = join(appDirectory, 'dist', 'web', 'firebase-messaging-worker.js');
  const outputPathFromNotifications = '../../apps/ammu-sammu-customer/dist/web/firebase-messaging-worker.js';
  const resultPath = exportWeb(appKey, {
    root,
    runCommand(command, args, options) {
      calls.push({ args, command, cwd: options.cwd });
      if (calls.length === 1) {
        mkdirSync(join(appDirectory, 'dist', 'web'), { recursive: true });
        writeFileSync(join(appDirectory, 'dist', 'web', 'index.html'), 'app');
      }
      if (calls.length === 2) writeFileSync(workerOutput, 'bundled worker');
      return { status: 0, signal: null };
    },
  });

  assert.equal(resultPath, workerOutput);
  assert.deepEqual(calls, [
    {
      command: 'npm',
      args: ['exec', '--', 'expo', 'export', '--platform', 'web', '--output-dir', 'dist/web'],
      cwd: appDirectory,
    },
    {
      command: 'npm',
      args: ['run', 'build:worker', '--', `--outfile=${outputPathFromNotifications}`],
      cwd: notificationsDirectory,
    },
  ]);
});

test('unknown targets and export failures never start the worker bundle', (t) => {
  const { appKey, root } = fixture(t);
  let calls = 0;
  assert.throws(() => exportWeb('../../tmp/attacker', { root, runCommand() { calls++; } }), /Unknown app target/);
  assert.throws(() => exportWeb(appKey, {
    root,
    runCommand() { calls++; return { status: 1, signal: null }; },
  }), /Expo web export.*status 1/);
  assert.equal(calls, 1);
});

test('worker bundling errors and signals fail the app export', (t) => {
  const { appKey, appDirectory, root } = fixture(t);
  let calls = 0;
  assert.throws(() => exportWeb(appKey, {
    root,
    runCommand() {
      calls++;
      if (calls === 1) {
        mkdirSync(join(appDirectory, 'dist', 'web'), { recursive: true });
        writeFileSync(join(appDirectory, 'dist', 'web', 'index.html'), 'app');
      }
      return calls === 1 ? { status: 0, signal: null } : { status: null, signal: 'SIGTERM' };
    },
  }), /worker bundle.*signal SIGTERM/);
  assert.equal(calls, 2);
});

test('spawn errors, export signals, missing output and worker exit failures are reported', (t) => {
  const { appKey, appDirectory, root } = fixture(t);
  const spawnError = new Error('spawn failed');
  assert.throws(() => exportWeb(appKey, { root, runCommand: () => ({ error: spawnError }) }), /spawn failed/);
  assert.throws(() => exportWeb(appKey, { root, runCommand: () => ({ status: null, signal: 'SIGKILL' }) }), /Expo web export.*SIGKILL/);
  assert.throws(() => exportWeb(appKey, { root, runCommand: () => ({ status: 0 }) }), /Expo web export.*nonempty file/);
  let calls = 0;
  assert.throws(() => exportWeb(appKey, {
    root,
    runCommand() {
      if (++calls === 1) {
        mkdirSync(join(appDirectory, 'dist', 'web'), { recursive: true });
        writeFileSync(join(appDirectory, 'dist', 'web', 'index.html'), 'app');
      }
      return { status: calls === 1 ? 0 : 2 };
    },
  }), /worker bundle.*status 2/);
  calls = 0;
  assert.throws(() => exportWeb(appKey, { root, runCommand() {
    if (++calls === 1) writeFileSync(join(appDirectory, 'dist', 'web', 'index.html'), 'app');
    return { status: 0 };
  } }), /worker bundle.*nonempty file/);
});
