import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readMainMigrationPolicy, migrationChanges, evaluateTrustedMigrations, checkBaselineExists } from './trusted-migration-policy.mjs';

const repository = 'owner/repo', sha = 'a'.repeat(40), headSha = 'c'.repeat(40), baselineCommit = 'b'.repeat(40);
const baselineFile = '20261117000000_baseline.sql';
const policyPath = 'supabase/migration-policy.json';
const migration = name => `supabase/migrations/${name}.sql`;
function fixture(mode = 'pre-release-baseline', options = {}) {
  const calls = [];
  const request = async path => {
    calls.push(path);
    if (path === `/repos/${repository}/git/ref/heads/main`) {
      if (options.refError) throw Object.assign(new Error('main API failure'), { status: options.refError });
      return { data: options.ref ?? { object: { type: 'commit', sha } } };
    }
    if (path === `/repos/${repository}/contents/supabase/migrations?ref=${headSha}`) {
      if (options.dirError) throw Object.assign(new Error('directory API failure'), { status: options.dirError });
      return { data: options.dir ?? [{ type: 'file', name: baselineFile }] };
    }
    if (path === `/repos/${repository}/compare/${baselineCommit}...${headSha}?per_page=1`) {
      if (options.compareError) throw Object.assign(new Error('compare API failure'), { status: options.compareError });
      return { data: { status: options.compareStatus ?? 'ahead' } };
    }
    assert.equal(path, `/repos/${repository}/contents/${policyPath}?ref=${sha}`, 'only the policy at the resolved main commit may be read');
    if (options.fileError) throw Object.assign(new Error('contents API failure'), { status: options.fileError });
    return { data: options.file ?? { type: 'file', path: policyPath, encoding: 'base64', content: Buffer.from(options.json ?? JSON.stringify({ mode, baseline: { version: '20261117000000', commit: baselineCommit } })).toString('base64') } };
  };
  return { calls, request, run: (files = [], body = '') => evaluateTrustedMigrations({ repository, request, files, body, headSha }) };
}

test('effective rule is pinned to main, ignoring the PR base, policy edit and proposed mode', async () => {
  const f = fixture('frozen');
  const verdict = await f.run([
    { filename: policyPath, status: 'modified' }, // The proposed contents are never requested or used.
    { filename: migration('baseline'), status: 'modified' },
  ], 'Issue: #77\nProposed mode: pre-release-open');
  assert.equal(verdict.errors.length, 1);
  assert.match(verdict.errors[0], /frozen/);
  assert.deepEqual(f.calls.slice(0, 2), [`/repos/${repository}/git/ref/heads/main`, `/repos/${repository}/contents/${policyPath}?ref=${sha}`]);
  assert.ok(f.calls.slice(2).every(call => call.includes(headSha) && !call.includes(policyPath)), 'existence checks use the head sha only and never the PR policy copy');
});

test('baseline additions, copies and renames into migrations are refused; baseline edits remain allowed', async () => {
  for (const change of [
    { filename: migration('new'), status: 'added' },
    { filename: migration('copy'), status: 'copied' },
    { filename: migration('moved'), previous_filename: 'old.sql', status: 'renamed' },
  ]) assert.equal((await fixture().run([change])).errors.length, 1);
  assert.deepEqual((await fixture().run([{ filename: migration('baseline'), status: 'modified' }])).errors, []);
});

test('existing explicit migration override works for baseline additions but cannot rewrite frozen history', async () => {
  const override = 'Issue: #77\nMigration-Policy-Override: shared staging applied the baseline';
  assert.deepEqual((await fixture().run([{ filename: migration('new'), status: 'added' }], override)).errors, []);
  for (const change of [
    { filename: migration('baseline'), status: 'modified' },
    { filename: migration('baseline'), status: 'removed' },
    { filename: 'elsewhere.sql', previous_filename: migration('baseline'), status: 'renamed' },
    { filename: migration('20270101000000_new'), previous_filename: migration('baseline'), status: 'renamed' },
  ]) assert.equal((await fixture('frozen').run([change], override)).errors.length, 1);
  assert.deepEqual((await fixture('frozen').run([{ filename: migration('20270101000000_new'), status: 'added' }])).errors, []);
  assert.equal((await fixture('frozen').run([{ filename: migration('new'), status: 'added' }])).errors.length, 1);
});

test('open mode warnings and non-migration changes preserve the existing policy semantics', async () => {
  const warned = await fixture('pre-release-open').run([{ filename: migration('new'), status: 'added' }]);
  assert.deepEqual(warned.errors, []); assert.equal(warned.warnings.length, 1);
  for (const mode of ['pre-release-open', 'pre-release-baseline', 'frozen']) {
    assert.deepEqual(await fixture(mode).run([{ filename: 'docs/WORKFLOW.md', status: 'modified' }]), { errors: [], warnings: [] });
  }
});

test('only a missing policy on main permits bootstrap; other API and main-ref failures propagate', async () => {
  assert.deepEqual(await fixture(undefined, { fileError: 404 }).run(), { errors: [], warnings: [] });
  for (const options of [{ refError: 404 }, { refError: 503 }, { fileError: 403 }, { fileError: 503 }]) {
    await assert.rejects(fixture(undefined, options).run(), /API failure/);
  }
});

test('invalid or truncated trusted main policy never becomes a successful verdict', async () => {
  for (const options of [
    { ref: {} }, { ref: { object: { type: 'tag', sha } } }, { ref: { object: { type: 'commit', sha: 'not-a-sha' } } },
    { json: '{' }, { json: 'null' }, { json: '[]' }, { json: '{"mode":"invented"}' },
    { file: { type: 'file', path: policyPath, encoding: 'none', content: '' } },
    { file: { type: 'file', path: policyPath, encoding: 'base64', content: '!!!!' } },
    { file: { type: 'file', path: policyPath, encoding: 'base64', content: 'e30=', truncated: true } },
  ]) await assert.rejects(fixture(undefined, options).run());
});

test('missing file status or rename source is an incomplete-data error, not a policy exemption', () => {
  for (const file of [{}, { filename: migration('x') }, { filename: migration('x'), status: 'unknown' }, { filename: migration('x'), status: 'renamed' }]) assert.throws(() => migrationChanges([file]), /incomplete/);
  assert.deepEqual(migrationChanges([{ filename: migration('x'), status: 'changed' }]), [{ status: 'M', path: migration('x') }]);
});

test('an active main policy cannot be removed or renamed away by the PR', async () => {
  for (const file of [{ filename: policyPath, status: 'removed' }, { filename: 'other.json', previous_filename: policyPath, status: 'renamed' }]) {
    assert.match((await fixture().run([file])).errors[0], /must remain present/);
  }
});

test('unchanged file metadata contributes no migration rewrite', async () => {
  const file = { filename: migration('baseline'), status: 'unchanged' };
  assert.deepEqual(migrationChanges([file]), []);
  assert.deepEqual(await fixture('frozen').run([file]), { errors: [], warnings: [] });
});

test('ruleset proposal preserves strict main checks, no bypasses and a feasible sole-owner review gate', () => {
  const ruleset = JSON.parse(readFileSync(new URL('../../docs/policy/main-delivery-ruleset.json', import.meta.url), 'utf8'));
  assert.equal(ruleset.target, 'branch'); assert.equal(ruleset.enforcement, 'active');
  assert.deepEqual(ruleset.conditions.ref_name, { include: ['refs/heads/main'], exclude: [] });
  assert.deepEqual(ruleset.bypass_actors, []);
  const checks = ruleset.rules.find(rule => rule.type === 'required_status_checks').parameters;
  assert.equal(checks.strict_required_status_checks_policy, true);
  assert.equal(checks.do_not_enforce_on_create, false);
  assert.deepEqual(checks.required_status_checks, [{ context: 'Delivery policy', integration_id: 15368 }]);
  const reviews = ruleset.rules.find(rule => rule.type === 'pull_request').parameters;
  assert.equal(reviews.required_approving_review_count, 0); assert.equal(reviews.require_code_owner_review, false);
});

test('privileged workflow checks out main without persisted credentials, never the PR head', () => {
  const workflow = readFileSync(new URL('../workflows/delivery-policy.yml', import.meta.url), 'utf8');
  assert.match(workflow, /pull_request_target:/);
  assert.match(workflow, /ref: main\n/);
  assert.match(workflow, /persist-credentials: false/);
  assert.doesNotMatch(workflow, /pull_request\.head|pull_request\.merge_commit|npm (?:ci|install)/);
});

test('frozen policy from main requires new migrations to sort after the recorded baseline', async () => {
  const json = JSON.stringify({ mode: 'frozen', baseline: { version: '20261117000000', commit: baselineCommit } });
  const add = name => [{ filename: migration(name), status: 'added' }];
  assert.deepEqual((await fixture('frozen', { json }).run(add('20261118000000_next'))).errors, []);
  assert.match((await fixture('frozen', { json }).run(add('20261116000000_older'))).errors.join(), /after the baseline/);
  assert.match((await fixture('frozen', { json }).run(add('20261117000000_same'))).errors.join(), /after the baseline/);
  assert.match((await fixture('frozen', { json }).run([{ filename: migration('20261117000000_baseline'), status: 'modified' }])).errors.join(), /frozen/i);
});

test('frozen existence check: baseline file and commit present and an ancestor passes', async () => {
  assert.deepEqual((await fixture('frozen').run()).errors, []);
  assert.deepEqual((await fixture('frozen', { compareStatus: 'identical' }).run()).errors, []);
});

test('frozen existence check: missing baseline file is rejected', async () => {
  for (const options of [{ dir: [{ type: 'file', name: '20261118000000_other.sql' }] }, { dir: [] }, { dir: [{ type: 'dir', name: baselineFile }] }, { dir: [{ type: 'file', name: '20261117000000_baseline.txt' }] }, { dirError: 404 }]) {
    assert.match((await fixture('frozen', options).run()).errors.join(), /baseline migration .* does not exist/);
  }
});

test('frozen existence check: unknown baseline commit is rejected', async () => {
  for (const compareError of [404, 422]) assert.match((await fixture('frozen', { compareError }).run()).errors.join(), /does not exist in this repository/);
});

test('frozen existence check: a non-ancestor baseline commit is rejected', async () => {
  for (const compareStatus of ['behind', 'diverged']) assert.match((await fixture('frozen', { compareStatus }).run()).errors.join(), /not an ancestor/);
});

test('frozen existence check fails closed when it cannot verify', async () => {
  await assert.rejects(fixture('frozen', { dirError: 503 }).run(), /directory API failure/);
  await assert.rejects(fixture('frozen', { compareError: 503 }).run(), /compare API failure/);
  await assert.rejects(fixture('frozen', { compareStatus: 'weird' }).run(), /ancestry/);
  await assert.rejects(fixture('frozen', { dir: new Array(1000).fill({ type: 'file', name: 'x.sql' }) }).run(), /incomplete or capped/);
  await assert.rejects(evaluateTrustedMigrations({ repository, request: fixture('frozen').request, files: [], body: '' }), /head commit/);
});

test('frozen existence check rejects a baseline without a version and commit, and other modes skip it', async () => {
  const request = async () => assert.fail('must not call the API');
  for (const baseline of [undefined, null, [], {}, { version: '20261117000000' }, { version: '1', commit: baselineCommit }, { version: '20261117000000', commit: 'B'.repeat(40) }]) {
    assert.match((await checkBaselineExists({ repository, request, baseline, headSha })).join(), /14-digit version and a 40-character/);
  }
  for (const mode of ['pre-release-open', 'pre-release-baseline']) {
    const f = fixture(mode); await f.run();
    assert.equal(f.calls.length, 2, `${mode} makes no existence calls`);
  }
});
