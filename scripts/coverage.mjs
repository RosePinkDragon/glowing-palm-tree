// Node unit-test coverage (#231). Runs every Node test suite once with Node's built-in coverage, writes one lcov file
// per suite to coverage/, and prints a line, branch and function table per area and in total. Report-only: no thresholds.
// In GitHub Actions the table is also appended to the job summary. `npm run check` is unchanged and does not use this.
import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

/** Node flags that print the normal spec report and also write an lcov file. Test files and dependencies are excluded. */
export function coverageArgs(lcovFile) {
  return [
    '--experimental-test-coverage',
    '--test-reporter=spec', '--test-reporter-destination=stdout',
    '--test-reporter=lcov', `--test-reporter-destination=${lcovFile}`,
    ...['**/*.test.*', '**/node_modules/**', '**/test/**', '**/tests/**', '**/test-loader.mjs', '**/test-environment.ts']
      .map(pattern => `--test-coverage-exclude=${pattern}`),
  ];
}

/** Parses lcov text into records keyed by source file: line hits, branch hits and function hits. */
export function parseLcov(text, files = new Map()) {
  let record;
  for (const line of text.split('\n')) {
    const [tag, ...rest] = [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 1)];
    const value = rest.join(':');
    if (tag === 'SF') {
      record = files.get(value) ?? { lines: new Map(), branches: new Map(), functions: new Map() };
      files.set(value, record);
    } else if (!record) continue;
    else if (tag === 'DA') { const [n, hits] = value.split(','); keepMax(record.lines, n, Number(hits)); }
    else if (tag === 'BRDA') { const parts = value.split(','); keepMax(record.branches, parts.slice(0, 3).join(','), parts[3] === '-' ? 0 : Number(parts[3])); }
    else if (tag === 'FN') { const comma = value.indexOf(','); keepMax(record.functions, value.slice(comma + 1), 0); }
    else if (tag === 'FNDA') { const comma = value.indexOf(','); keepMax(record.functions, value.slice(comma + 1), Number(value.slice(0, comma))); }
  }
  return files;
}

function keepMax(map, key, hits) { map.set(key, Math.max(map.get(key) ?? 0, hits)); }

const covered = map => [...map.values()].filter(hits => hits > 0).length;

/** One row per area (apps/x, packages/x, .github/scripts, ...) plus a total, merging every suite that touched a file. */
export function summarize(files) {
  const areas = new Map();
  const area = name => areas.get(name) ?? areas.set(name, { name, lines: [0, 0], branches: [0, 0], functions: [0, 0] }).get(name);
  const total = { name: 'total', lines: [0, 0], branches: [0, 0], functions: [0, 0] };
  for (const [file, record] of files) {
    const parts = file.split('/');
    const name = ['packages', 'apps'].includes(parts[0]) ? parts.slice(0, 2).join('/') : parts[0] === '.github' ? '.github/scripts' : parts[0];
    for (const target of [area(name), total]) {
      for (const kind of ['lines', 'branches', 'functions']) {
        target[kind][0] += covered(record[kind]);
        target[kind][1] += record[kind].size;
      }
    }
  }
  return [...[...areas.values()].sort((a, b) => a.name.localeCompare(b.name)), total];
}

const percent = ([hit, all]) => all ? `${(100 * hit / all).toFixed(1)}% (${hit}/${all})` : 'n/a';

export function markdownTable(rows) {
  return ['| Area | Lines | Branches | Functions |', '| --- | --- | --- | --- |',
    ...rows.map(row => `| ${row.name === 'total' ? '**total**' : row.name} | ${percent(row.lines)} | ${percent(row.branches)} | ${percent(row.functions)} |`)].join('\n');
}

function listTests(directory, pattern) {
  return readdirSync(resolve(root, directory)).filter(name => pattern.test(name)).sort().map(name => `${directory}/${name}`);
}

function main() {
  const directory = resolve(root, 'coverage');
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  let failed = false;
  const suites = [
    ['github-scripts', listTests('.github/scripts', /\.test\.mjs$/)],
    ['config', ['config/app-config.test.cjs']],
    ['scripts', listTests('scripts', /\.test\.mjs$/)],
  ];
  for (const [name, files] of suites) {
    console.log(`\n# ${name}`);
    const result = spawnSync(process.execPath, ['--test', '--test-isolation=none', ...coverageArgs(resolve(directory, `${name}.lcov`)), ...files], { cwd: root, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) failed = true;
  }
  console.log('\n# packages');
  const packages = spawnSync(process.execPath, ['scripts/test-packages.mjs'], { cwd: root, stdio: 'inherit', env: { ...process.env, COVERAGE_DIR: directory } });
  if (packages.error) throw packages.error;
  if (packages.status !== 0) failed = true;

  const files = new Map();
  for (const name of readdirSync(directory).filter(item => item.endsWith('.lcov'))) {
    parseLcov(readFileSync(resolve(directory, name), 'utf8'), files);
  }
  const table = markdownTable(summarize(files));
  console.log(`\nCoverage (report only, no threshold; lcov files in ${relative(root, directory)}/)\n\n${table}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Node test coverage\n\nReport only, no threshold. Only files that a test loads are counted; test files and node_modules are excluded.\n\n${table}\n\n`);
  }
  if (failed) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) main();
