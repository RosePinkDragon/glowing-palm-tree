import { readFileSync, rmSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const appKeys = [
  'ammu-sammu-customer',
  'ammu-sammu-admin',
  'kokani-dine-inn-customer',
  'kokani-dine-inn-admin',
];

const defaultRoot = resolve(import.meta.dirname, '..');

function readManifest(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`Could not read workspace manifest at ${path}: ${error.message}`, { cause: error });
  }
}

function assertCommandSucceeded(result, label) {
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`${label} terminated with signal ${result.signal}.`);
  if (result.status !== 0) throw new Error(`${label} exited with status ${result.status ?? 'unknown'}.`);
}

function assertNonemptyFile(path, label) {
  try {
    const stat = statSync(path);
    if (stat.isFile() && stat.size > 0) return;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  throw new Error(`${label} did not produce a nonempty file at ${path}.`);
}

export function exportWeb(appKey, { root = defaultRoot, runCommand = spawnSync } = {}) {
  if (!appKeys.includes(appKey)) {
    throw new Error(`Unknown app target: ${appKey}. Expected one of: ${appKeys.join(', ')}.`);
  }

  const appDirectory = resolve(root, 'apps', appKey);
  const appManifest = readManifest(resolve(appDirectory, 'package.json'));
  if (appManifest.name !== appKey) {
    throw new Error(`App target ${appKey} does not match workspace ${appManifest.name}.`);
  }

  const notificationsDirectory = resolve(root, 'packages', 'notifications');
  const notificationsManifest = readManifest(resolve(notificationsDirectory, 'package.json'));
  if (notificationsManifest.name !== '@market/notifications' || !notificationsManifest.scripts?.['build:worker']) {
    throw new Error('The notifications workspace must provide its build:worker script.');
  }

  const indexOutput = resolve(appDirectory, 'dist', 'web', 'index.html');
  const workerOutput = resolve(appDirectory, 'dist', 'web', 'firebase-messaging-worker.js');
  rmSync(indexOutput, { force: true });
  rmSync(workerOutput, { force: true });
  const exportResult = runCommand('npm', [
    'exec', '--', 'expo', 'export', '--platform', 'web', '--output-dir', 'dist/web',
  ], { cwd: appDirectory, stdio: 'inherit' });
  assertCommandSucceeded(exportResult, `Expo web export for ${appKey}`);

  assertNonemptyFile(indexOutput, `Expo web export for ${appKey}`);
  const relativeWorkerOutput = relative(notificationsDirectory, workerOutput);
  const workerResult = runCommand('npm', [
    'run', 'build:worker', '--', `--outfile=${relativeWorkerOutput}`,
  ], { cwd: notificationsDirectory, stdio: 'inherit' });
  assertCommandSucceeded(workerResult, `Firebase messaging worker bundle for ${appKey}`);
  assertNonemptyFile(workerOutput, `Firebase messaging worker bundle for ${appKey}`);
  return workerOutput;
}

function isDirectExecution() {
  return process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
}

if (isDirectExecution()) {
  if (process.argv.length !== 3) {
    console.error('Usage: node scripts/export-web.mjs <app-target>');
    process.exit(2);
  }
  try {
    exportWeb(process.argv[2]);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
