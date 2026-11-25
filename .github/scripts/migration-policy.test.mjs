import test from 'node:test';
import assert from 'node:assert/strict';
import { checkMigrationPolicy, parseOverride } from './migration-policy.mjs';

const m = name => `supabase/migrations/${name}.sql`;
const add = { status: 'A', path: m('20270101000000_new') };
const edit = { status: 'M', path: m('20261112000000_database_isolation') };
const del = { status: 'D', path: m('20261112000001_checkout') };
const baselineVersion = '20261117000000';
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
  assert.deepEqual(checkMigrationPolicy({ mode: 'frozen', baselineVersion, files: [add, other] }), { errors: [], warnings: [] });
  assert.match(checkMigrationPolicy({ mode: 'frozen', baselineVersion, files: [edit] }).errors.join(), /frozen/i);
  assert.match(checkMigrationPolicy({ mode: 'frozen', baselineVersion, files: [del] }).errors.join(), /frozen/i);
  const renamed = { status: 'R', previous: m('20261112000001_checkout'), path: m('20270101000001_checkout') };
  assert.match(checkMigrationPolicy({ mode: 'frozen', baselineVersion, files: [renamed] }).errors.join(), /frozen/i);
});
test('frozen requires timestamped names that sort after the baseline', () => {
  const named = path => [{ status: 'A', path: `supabase/migrations/${path}` }];
  const baselineVersion = '20261117000000';
  assert.deepEqual(checkMigrationPolicy({ mode: 'frozen', baselineVersion, files: named('20261118090000_add_x.sql') }).errors, []);
  for (const bad of ['new.sql', '2026_new.sql', '20261118090000_Upper.sql', '20261118090000_x.txt', '20261118090000.sql']) {
    assert.match(checkMigrationPolicy({ mode: 'frozen', baselineVersion, files: named(bad) }).errors.join(), /timestamp/, bad);
  }
  assert.match(checkMigrationPolicy({ mode: 'frozen', baselineVersion, files: named('20261117000000_dup.sql') }).errors.join(), /after the baseline/);
  assert.match(checkMigrationPolicy({ mode: 'frozen', baselineVersion, files: named('20261101000000_old.sql') }).errors.join(), /after the baseline/);
});
test('frozen forbids editing, deleting or renaming the recorded baseline file', () => {
  const baseline = 'supabase/migrations/20261117000000_baseline.sql';
  for (const file of [{ status: 'M', path: baseline }, { status: 'D', path: baseline }, { status: 'R', previous: baseline, path: 'supabase/migrations/20261118000000_baseline.sql' }]) {
    assert.match(checkMigrationPolicy({ mode: 'frozen', baselineVersion, files: [file] }).errors.join(), /frozen/i);
  }
});
test('frozen cannot be overridden', () => {
  assert.match(checkMigrationPolicy({ mode: 'frozen', baselineVersion, files: [edit], override: 'because' }).errors.join(), /frozen/i);
});
test('a rename into migrations counts as an add in baseline mode', () => {
  const moved = { status: 'R', previous: 'old/x.sql', path: m('20270101000002_x') };
  assert.equal(checkMigrationPolicy({ mode: 'pre-release-baseline', files: [moved] }).errors.length, 1);
});
test('lookalike paths are not migrations', () => {
  const files = [{ status: 'A', path: 'supabase/migrationsx/y.sql' }];
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

test('frozen rejects missing and malformed baseline versions', () => {
  for (const version of [undefined, '', '123', 20261117000000, null]) {
    assert.match(checkMigrationPolicy({ mode: 'frozen', files: [add], baselineVersion: version }).errors.join(), /baseline version.*14-digit/);
  }
});
test('migration paths are case insensitive and frozen nested paths are rejected', () => {
  const upper = { status: 'M', path: 'Supabase/Migrations/old.sql' };
  assert.match(checkMigrationPolicy({ mode: 'frozen', baselineVersion, files: [upper] }).errors.join(), /frozen/i);
  assert.match(checkMigrationPolicy({ mode: 'pre-release-baseline', files: [{ ...upper, status: 'A' }] }).errors.join(), /do not add/);
  for (const status of ['A', 'M', 'D']) {
    assert.match(checkMigrationPolicy({ mode: 'frozen', baselineVersion, files: [{ status, path: 'SUPABASE/MIGRATIONS/sub/20270101000000_x.sql' }] }).errors.join(), /nested/i);
  }
  assert.deepEqual(checkMigrationPolicy({ mode: 'frozen', baselineVersion, files: [{ status: 'A', path: 'Supabase/Migrations/20270101000000_x.sql' }] }).errors, []);
});
test('policy changes call out owner approval', () => {
  assert.match(checkMigrationPolicy({ mode: 'frozen', baselineVersion, files: [{ status: 'M', path: 'supabase/migration-policy.json' }] }).warnings.join(), /explicit owner approval/);
});

test('frozen rejects timestamps more than one year ahead', () => {
  const now = new Date('2026-11-25T12:00:00Z');
  const file = timestamp => [{ status: 'A', path: m(`${timestamp}_new`) }];
  assert.deepEqual(checkMigrationPolicy({ mode: 'frozen', baselineVersion, now, files: file('20271125120000') }).errors, []);
  assert.match(checkMigrationPolicy({ mode: 'frozen', baselineVersion, now, files: file('99991231235959') }).errors.join(), /one year in the future/);
});

test('frozen detects migration paths containing newlines', () => {
  for (const path of ['supabase/migrations/x\ny.sql', 'supabase/migrations/sub/x\ny.sql', 'supabase/migrations/sub\nx/y.sql']) {
    assert.match(checkMigrationPolicy({ mode: 'frozen', baselineVersion, files: [{ status: 'M', path }] }).errors.join(), /frozen/i);
  }
  assert.match(checkMigrationPolicy({ mode: 'frozen', baselineVersion, files: [{ status: 'A', path: 'supabase/migrations/sub\nx/y.sql' }] }).errors.join(), /nested/i);
});
