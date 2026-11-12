import { access, readFile, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const ignoredDirectories = new Set(['.expo', '.turbo', 'build', 'coverage', 'dist', 'node_modules']);
const packagesRoot = resolve(process.argv[2] ?? resolve(import.meta.dirname, '..', 'packages'));

if (process.argv.length > 3) {
  console.error('Usage: node scripts/test-packages.mjs [packages-directory]');
  process.exit(2);
}

async function packageDirectories(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const packages = [];
  for (const entry of entries.filter((item) => item.isDirectory() && !ignoredDirectories.has(item.name)).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = resolve(directory, entry.name);
    try {
      await access(resolve(path, 'package.json'));
      packages.push(path);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return packages;
}

async function packageTests(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory() && !ignoredDirectories.has(entry.name)) {
      files.push(...await packageTests(resolve(directory, entry.name)));
    } else if (entry.isFile() && /\.test\.(?:ts|mjs)$/.test(entry.name)) {
      files.push(resolve(directory, entry.name));
    }
  }
  return files.sort();
}

const packages = await packageDirectories(packagesRoot);
let testedPackages = 0;
let failed = false;

for (const packageDirectory of packages) {
  const manifest = JSON.parse(await readFile(resolve(packageDirectory, 'package.json'), 'utf8'));
  const packageName = manifest.name ?? packageDirectory;
  const testScript = manifest.scripts?.test;
  if (typeof testScript === 'string' && testScript.trim()) {
    testedPackages++;
    console.log(`Package test script: ${packageName}`);
    const result = spawnSync('npm', ['run', 'test'], { cwd: packageDirectory, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.signal || result.status !== 0) failed = true;
    continue;
  }

  const files = await packageTests(packageDirectory);
  if (!files.length) {
    console.log(`No tests found for ${packageName}; skipped.`);
    continue;
  }
  testedPackages++;
  console.log(`Package tests (${files.length}): ${packageName}`);
  const result = spawnSync(process.execPath, ['--test', '--test-isolation=none', ...files], {
    cwd: packageDirectory,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.signal || result.status !== 0) failed = true;
}

if (!testedPackages) {
  console.error(`No package tests found under ${packagesRoot}. Expected a package test script or .test.ts/.test.mjs files.`);
  process.exitCode = 1;
} else if (failed) {
  process.exitCode = 1;
}
