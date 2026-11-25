// Static discovery only: run from the repository root. This does not execute tests.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const groups = {
  node: files.filter(f => /(?:\.test\.(?:ts|mjs|cjs))$/.test(f)),
  deno: files.filter(f => /^supabase\/functions\/.*_test\.ts$/.test(f)),
  browser: files.filter(f => /^tests\/browser\/.*\.mjs$/.test(f)),
  database: files.filter(f => /^tests\/database\/.*\.(?:sql|sh)$/.test(f)),
  workflows: files.filter(f => /^\.github\/workflows\/.*\.ya?ml$/.test(f)),
};
const matches = (text, pattern) => [...text.matchAll(pattern)].length;
for (const [group, paths] of Object.entries(groups)) {
  console.log(`\n${group}: ${paths.length} tracked files`);
  const totals = { declarations: 0, asserts: 0, markers: 0 };
  for (const path of paths) {
    const text = readFileSync(path, 'utf8');
    const declarations = matches(text, /\b(?:Deno\.)?(?:test|it)(?:\.(?:skip|todo|only))?\s*\(/g);
    const asserts = matches(text, /\b(?:assert(?:\.[\w]+)?|expect|test_assert)\s*\(/g);
    const markers = matches(text, /\b(?:test|it)\.(?:skip|todo)\s*\(/g);
    totals.declarations += declarations;
    totals.asserts += asserts;
    totals.markers += markers;
    console.log(`${path}\tdeclarations=${declarations}\trecognized-assertion-call-sites=${asserts}\tskip-todo-markers=${markers}`);
  }
  console.log(`TOTAL\tdeclarations=${totals.declarations}\trecognized-assertion-call-sites=${totals.asserts}\tskip-todo-markers=${totals.markers}`);
}
