import test from 'node:test';
import assert from 'node:assert/strict';
import { checkMigrationPolicy, parseOverride } from './migration-policy.mjs';

const m = name => `supabase/migrations/${name}.sql`;
const add = { status: 'A', path: m('20270101000000_new') };
const edit = { status: 'M', path: m('20261112000000_database_isolation') };
const del = { status: 'D', path: m('20261112000001_checkout') };
const other = { status: 'M', path: 'docs/RELEASE.md' };

test('pre-release-open only warns about added migrations', () => {
  assert.deepEqual(checkMigrationPolicy({ mode: 'pre-release-open', files: [add, edit, other] }).errors, []);
  assert.equal(checkMigrationPolicy({ mode: 'pre-release-open', files: [add] }).warnings.length, 1);
  assert.equal(checkMigrationPolicy({ mode: 'pre-release-open', files: [edit, other] }).warnings.length, 0);
});
test('pre-release-baseline rejects added migrations unless overridden', () => {
  assert.equal(checkMigrationPolicy({ mode: 'pre-release-baseline', files: [add] }).errors.length, 1);
  assert.deepEqual(checkMigrationPolicy({ mode: 'pre-release-baseline', files: [add], override: 'shared staging applied baseline' }).errors, []);
  assert.equal(checkMigrationPolicy({ mode: 'pre-release-baseline', files: [add], override: '  ' }).errors.length, 1);
});
test('pre-release-baseline allows editing the baseline and non-migration files', () => {
  assert.deepEqual(checkMigrationPolicy({ mode: 'pre-release-baseline', files: [edit, del, other] }).errors, []);
});
test('frozen rejects modify, delete and rename of migrations but allows adds', () => {
  assert.deepEqual(checkMigrationPolicy({ mode: 'frozen', files: [add, other] }), { errors: [], warnings: [] });
  assert.equal(checkMigrationPolicy({ mode: 'frozen', files: [edit] }).errors.length, 1);
  assert.equal(checkMigrationPolicy({ mode: 'frozen', files: [del] }).errors.length, 1);
  const renamed = { status: 'R', previous: m('20261112000001_checkout'), path: m('20270101000001_checkout') };
  assert.equal(checkMigrationPolicy({ mode: 'frozen', files: [renamed] }).errors.length, 1);
});
test('frozen cannot be overridden', () => {
  assert.equal(checkMigrationPolicy({ mode: 'frozen', files: [edit], override: 'because' }).errors.length, 1);
});
test('a rename into migrations counts as an add in baseline mode', () => {
  const moved = { status: 'R', previous: 'old/x.sql', path: m('20270101000002_x') };
  assert.equal(checkMigrationPolicy({ mode: 'pre-release-baseline', files: [moved] }).errors.length, 1);
});
test('nested or lookalike paths are not migrations', () => {
  const files = [{ status: 'A', path: 'supabase/migrations/sub/x.sql' }, { status: 'A', path: 'supabase/migrationsx/y.sql' }];
  assert.deepEqual(checkMigrationPolicy({ mode: 'pre-release-baseline', files }).errors, []);
});
test('unknown mode fails closed', () => {
  assert.equal(checkMigrationPolicy({ mode: 'nope', files: [] }).errors.length, 1);
  assert.equal(checkMigrationPolicy({ mode: undefined, files: [] }).errors.length, 1);
});
test('parseOverride reads the PR body line', () => {
  assert.equal(parseOverride('Issue: #1\n\nMigration-Policy-Override: staging applied it\n'), 'staging applied it');
  assert.equal(parseOverride('Migration-Policy-Override:   '), '');
  assert.equal(parseOverride(null), '');
  assert.equal(parseOverride('text Migration-Policy-Override: x'), '');
});
