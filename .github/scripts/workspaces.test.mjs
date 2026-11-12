import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const source = resolve(import.meta.dirname, '../..');

async function fixture(t, manifest) {
  const root = await mkdtemp(resolve(tmpdir(), 'market-workspaces-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(resolve(root, 'scripts'), { recursive: true });
  await mkdir(resolve(root, 'config'), { recursive: true });
  await copyFile(resolve(source, 'scripts/workspaces.mjs'), resolve(root, 'scripts/workspaces.mjs'));
  await copyFile(resolve(source, 'config/app-targets.json'), resolve(root, 'config/app-targets.json'));
  await writeFile(resolve(root, 'package.json'), JSON.stringify({ private: true, workspaces: ['apps/*'] }));
  if (manifest) {
    await mkdir(resolve(root, 'apps/example'), { recursive: true });
    await writeFile(resolve(root, 'apps/example/package.json'), JSON.stringify(manifest));
  }
  return root;
}

function run(root, operation) {
  const result = spawnSync(process.execPath, [resolve(root, 'scripts/workspaces.mjs'), operation], { cwd: root, encoding: 'utf8' });
  if (result.error) throw result.error;
  return result;
}

const name = 'ammu-sammu-customer';

test('empty app directory skips exports', async (t) => {
  const result = run(await fixture(t), 'build:web');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /No app workspaces present yet/);
});

test('unknown app workspace fails', async (t) => {
  const result = run(await fixture(t, { name: 'unknown-app' }), 'build:web');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unknown app workspace name.*unknown-app/);
});

test('missing export script fails', async (t) => {
  const result = run(await fixture(t, { name }), 'export:native');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Missing script: "export:native"/);
});

test('selected export runs in the app workspace', async (t) => {
  const root = await fixture(t, { name, scripts: { 'build:web': 'node -e "require(\'node:fs\').writeFileSync(\'marker\', \'exported\')"' } });
  const result = run(root, 'build:web');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(resolve(root, 'apps/example/marker'), 'utf8'), 'exported');
});
