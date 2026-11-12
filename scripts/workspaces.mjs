import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const targets = JSON.parse(await readFile(resolve(root, 'config/app-targets.json'), 'utf8'));

async function appWorkspaces() {
  let entries;
  try { entries = await readdir(resolve(root, 'apps'), { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const apps = [];
  for (const entry of entries.filter((item) => item.isDirectory())) {
    let manifest;
    try { manifest = JSON.parse(await readFile(resolve(root, 'apps', entry.name, 'package.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!Object.hasOwn(targets, manifest.name)) {
      throw new Error(`Unknown app workspace name in apps/${entry.name}/package.json: ${manifest.name}`);
    }
    apps.push(manifest.name);
  }
  return apps.sort();
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.signal) process.exit(1);
  if (result.status !== 0) process.exit(result.status ?? 1);
}

async function testFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory() && entry.name !== 'node_modules') files.push(...await testFiles(path));
    else if (entry.isFile() && /\.(test|spec)\.(js|mjs|cjs|ts)$/.test(entry.name)) files.push(path);
  }
  return files;
}

const [operation, ...args] = process.argv.slice(2);
if (operation === 'test:core') {
  const files = await testFiles(resolve(root, 'packages/core'));
  if (files.length) run(process.execPath, ['--test', '--test-isolation=none', ...files]);
  else console.log('No core tests yet.');
} else if (operation === 'app') {
  const [name, command, ...rest] = args;
  if (!name || !command || !(await appWorkspaces()).includes(name)) {
    console.error('Usage: npm run app -- <installed-app-workspace> <command> [...args]');
    process.exit(1);
  }
  run('npm', ['run', command, '--workspace', name, ...(rest.length ? ['--', ...rest] : [])]);
} else if (operation === 'build:web' || operation === 'export:native') {
  const apps = await appWorkspaces();
  if (!apps.length) console.log('No app workspaces present yet.');
  for (const app of apps) run('npm', ['run', operation, '--workspace', app]);
} else {
  console.error(`Unknown workspace operation: ${operation}`);
  process.exit(1);
}
