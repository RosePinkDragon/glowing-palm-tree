import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { relative, resolve } from 'node:path';

const packagesRoot = resolve(import.meta.dirname, '..', 'packages');

async function findTests(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === 'node_modules') continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await findTests(path));
    else if (entry.isFile() && /\.test\.(?:ts|mjs)$/.test(entry.name)) files.push(path);
  }
  return files;
}

const files = (await findTests(packagesRoot)).sort();
if (!files.length) {
  console.error('No package tests found under packages/. Expected .test.ts or .test.mjs files.');
  process.exit(1);
}

for (const file of files) console.log(`Package test: ${relative(packagesRoot, file)}`);
const result = spawnSync(process.execPath, ['--test', '--test-isolation=none', ...files], {
  cwd: packagesRoot,
  stdio: 'inherit',
});
if (result.error) throw result.error;
if (result.signal) process.exit(1);
process.exit(result.status ?? 1);
