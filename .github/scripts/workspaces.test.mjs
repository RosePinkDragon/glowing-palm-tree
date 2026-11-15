import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const source = resolve(import.meta.dirname, '../..');
const names = Object.keys(JSON.parse(await readFile(resolve(source, 'config/app-targets.json'), 'utf8')));
const name = 'ammu-sammu-customer';
const markerScript = marker => `node -e "require('node:fs').writeFileSync('${marker}', 'exported')"`;
const manifests = () => names.map(name => ({ name, scripts: {
  'build:web': markerScript('web-marker'),
  'export:native': markerScript('native-marker'),
} }));

async function fixture(t, apps = manifests()) {
  const root = await mkdtemp(resolve(tmpdir(), 'market-workspaces-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(resolve(root, 'scripts'), { recursive: true });
  await mkdir(resolve(root, 'config'), { recursive: true });
  await copyFile(resolve(source, 'scripts/workspaces.mjs'), resolve(root, 'scripts/workspaces.mjs'));
  await copyFile(resolve(source, 'config/app-targets.json'), resolve(root, 'config/app-targets.json'));
  await writeFile(resolve(root, 'package.json'), JSON.stringify({ private: true, workspaces: ['apps/*'] }));
  for (const manifest of apps) {
    const directory = resolve(root, 'apps', manifest.name);
    await mkdir(directory, { recursive: true });
    await writeFile(resolve(directory, 'package.json'), JSON.stringify(manifest));
  }
  return root;
}

function run(root, operation, ...args) {
  const result = spawnSync(process.execPath, [resolve(root, 'scripts/workspaces.mjs'), operation, ...args], { cwd: root, encoding: 'utf8' });
  if (result.error) throw result.error;
  return result;
}

for (const operation of ['build:web', 'export:native']) {
  test(`${operation} refuses an absent or empty apps directory`, async t => {
    const root = await fixture(t, []);
    for (const emptyDirectory of [false, true]) {
      if (emptyDirectory) await mkdir(resolve(root, 'apps'));
      const result = run(root, operation);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Missing app workspaces/);
      for (const expected of names) assert.ok(result.stderr.includes(expected));
    }
  });

  test(`${operation} refuses a single missing app before exporting anything`, async t => {
    const present = manifests().filter(app => app.name !== name);
    const root = await fixture(t, present);
    const result = run(root, operation);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Missing app workspaces: ammu-sammu-customer/);
    for (const app of present) {
      await assert.rejects(readFile(resolve(root, 'apps', app.name, operation === 'build:web' ? 'web-marker' : 'native-marker')), { code: 'ENOENT' });
    }
  });

  test(`${operation} exports every configured app in its own workspace`, async t => {
    const root = await fixture(t);
    const result = run(root, operation);
    assert.equal(result.status, 0, result.stderr);
    for (const app of names) {
      assert.equal(await readFile(resolve(root, 'apps', app, operation === 'build:web' ? 'web-marker' : 'native-marker'), 'utf8'), 'exported');
    }
  });
}

test('unknown app workspace fails', async t => {
  const result = run(await fixture(t, [{ name: 'unknown-app' }]), 'build:web');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unknown app workspace name.*unknown-app/);
});

test('missing export script fails with the complete app set present', async t => {
  const apps = manifests();
  delete apps.find(app => app.name === name).scripts['export:native'];
  const result = run(await fixture(t, apps), 'export:native');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Missing script: "export:native"/);
});

test('targeted app command does not require unrelated app workspaces', async t => {
  const root = await fixture(t, manifests().filter(app => app.name === name));
  const result = run(root, 'app', name, 'build:web');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(resolve(root, 'apps', name, 'web-marker'), 'utf8'), 'exported');
});
