import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coverageArgs, markdownTable, parseLcov, summarize } from './coverage.mjs';

const lcov = (file, hits) => `TN:\nSF:${file}\nFN:1,a\nFN:5,b\nFNDA:${hits},a\nFNDA:0,b\nFNF:2\nFNH:1\nBRDA:2,0,0,${hits}\nBRDA:2,0,1,-\nBRF:2\nBRH:1\nDA:1,${hits}\nDA:2,0\nDA:3,1\nLF:3\nLH:2\nend_of_record\n`;

test('suites that load the same file are merged by taking the best hit count', () => {
  const files = parseLcov(lcov('packages/core/src/a.ts', 0));
  parseLcov(lcov('packages/core/src/a.ts', 4), files);
  assert.equal(files.size, 1);
  const [row, total] = summarize(files);
  assert.deepEqual([row.name, total.name], ['packages/core', 'total']);
  assert.deepEqual(row.lines, [2, 3]);
  assert.deepEqual(row.branches, [1, 2]);
  assert.deepEqual(row.functions, [1, 2]);
});

test('files are grouped by package, app and script area, with a total', () => {
  const files = parseLcov(lcov('packages/ui/src/a.ts', 1) + lcov('.github/scripts/x.mjs', 1) + lcov('apps/ammu-sammu-admin/a.ts', 1));
  assert.deepEqual(summarize(files).map(row => row.name), ['.github/scripts', 'apps/ammu-sammu-admin', 'packages/ui', 'total']);
  assert.match(markdownTable(summarize(files)), /\| \*\*total\*\* \| 66\.7% \(6\/9\) \| 33\.3% \(3\/9\)|\| \*\*total\*\* \| 66\.7% \(6\/9\)/);
});

test('an empty report renders n/a rather than dividing by zero', () => {
  assert.match(markdownTable(summarize(new Map())), /\| \*\*total\*\* \| n\/a \| n\/a \| n\/a \|/);
});

test('coverage flags exclude test files and node_modules and write lcov', () => {
  const args = coverageArgs('/tmp/x.lcov');
  assert.ok(args.includes('--experimental-test-coverage'));
  assert.ok(args.includes('--test-reporter-destination=/tmp/x.lcov'));
  assert.ok(args.includes('--test-coverage-exclude=**/*.test.*'));
  assert.ok(args.includes('--test-coverage-exclude=**/node_modules/**'));
});
