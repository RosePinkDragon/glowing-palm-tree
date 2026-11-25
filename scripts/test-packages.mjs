import { access, readFile, readdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { relative, resolve } from 'node:path';
import { coverageArgs } from './coverage.mjs';

const ignoredDirectories = new Set(['.expo', '.turbo', 'build', 'coverage', 'dist', 'node_modules']);
// With COVERAGE_DIR set (npm run coverage), each package's tests also write an lcov file there. Node does not accept
// --experimental-test-coverage through NODE_OPTIONS, so the flags are added to the package's own `node ... --test ...` script.
const coverageDirectory = process.env.COVERAGE_DIR;
const repositoryRoot = resolve(import.meta.dirname, '..');
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

// Node writes source paths relative to the package; make them relative to the repository so suites can be merged.
async function rebaseLcov(file, packageDirectory) {
  let text;
  try { text = await readFile(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  await writeFile(file, text.replace(/^SF:(.*)$/gm, (_, path) => `SF:${relative(repositoryRoot, resolve(packageDirectory, path))}`));
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
    const lcovFile = coverageDirectory && /^node\s/.test(testScript.trim()) ? resolve(coverageDirectory, `${packageDirectory.split(/[\\/]/).pop()}.lcov`) : undefined;
    if (coverageDirectory && !lcovFile) console.log(`Coverage skipped for ${packageName}: its test script does not start with node.`);
    const result = lcovFile
      ? spawnSync(`"${process.execPath}" ${coverageArgs(lcovFile).map(arg => `'${arg}'`).join(' ')} ${testScript.trim().replace(/^node\s+/, '')}`, { cwd: packageDirectory, stdio: 'inherit', shell: true })
      : spawnSync('npm', ['run', 'test'], { cwd: packageDirectory, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (lcovFile) await rebaseLcov(lcovFile, packageDirectory);
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
  const lcovFile = coverageDirectory ? resolve(coverageDirectory, `${packageDirectory.split(/[\\/]/).pop()}.lcov`) : undefined;
  const result = spawnSync(process.execPath, ['--test', '--test-isolation=none', ...(lcovFile ? coverageArgs(lcovFile) : []), ...files], {
    cwd: packageDirectory,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (lcovFile) await rebaseLcov(lcovFile, packageDirectory);
  if (result.signal || result.status !== 0) failed = true;
}

if (!testedPackages) {
  console.error(`No package tests found under ${packagesRoot}. Expected a package test script or .test.ts/.test.mjs files.`);
  process.exitCode = 1;
} else if (failed) {
  process.exitCode = 1;
}
