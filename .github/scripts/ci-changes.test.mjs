import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify } from './ci-changes.mjs';

const on = flags => Object.entries(flags).filter(([name, value]) => value && name !== 'secrets').map(([name]) => name).sort();

test('docs-only changes still scan committed secrets', () => {
  const flags = classify(['docs/RELEASE.md', 'AGENTS.md', 'README.md', 'packages/notifications/README.md', '.agents/skills/team-lead/SKILL.md']);
  assert.deepEqual(on(flags), ['docs_only']);
  assert.equal(flags.secrets, true);
  assert.equal(classify(['notes.md']).secrets, true);
});

test('docs/policy is read by a test, so it is not docs-only', () => {
  assert.deepEqual(on(classify(['docs/policy/main-delivery-ruleset.json'])), ['scripts', 'static_analysis']);
});

test('a script-only change runs the Node tests and nothing else', () => {
  assert.deepEqual(on(classify(['.github/scripts/pr-preflight.mjs', '.github/scripts/pr-preflight.test.mjs'])), ['scripts', 'static_analysis']);
  assert.deepEqual(on(classify(['supabase/migration-policy.json'])), ['scripts', 'static_analysis']);
});

test('a database-only change runs only the database suites', () => {
  assert.deepEqual(on(classify(['supabase/migrations/20261201000000_x.sql', 'tests/database/offers.sql', 'supabase/seed.sql'])), ['db']);
});

test('function-only changes include static analysis and browser-test-only changes stay narrow', () => {
  assert.deepEqual(on(classify(['supabase/functions/menu-photos/index.ts'])), ['functions', 'static_analysis']);
  assert.deepEqual(on(classify(['tests/browser/cart.mjs'])), ['browser']);
});

test('an app change runs the app and browser jobs but not the database or function jobs', () => {
  for (const file of ['apps/ammu-sammu-customer/App.tsx', 'packages/core/src/domain.ts', 'config/app-config.cjs', 'scripts/export-web.mjs', 'tsconfig.base.json', 'tests/fixtures/menu.ts']) {
    assert.deepEqual(on(classify([file])), ['app', 'browser', 'static_analysis'], file);
  }
});

test('mixed changes combine flags', () => {
  assert.deepEqual(on(classify(['docs/WORKFLOW.md', 'supabase/migrations/20261201000000_x.sql', '.github/scripts/pr-preflight.mjs'])), ['db', 'scripts', 'static_analysis']);
});

test('a change to the classifier itself runs everything', () => {
  for (const file of ['.github/scripts/ci-changes.mjs', '.github/scripts/ci-changes.test.mjs']) assert.equal(classify([file]).all, true, file);
  assert.equal(classify(['.github/scripts/pr-preflight.mjs']).all, false);
});

test('workflow, package and lockfile changes run everything', () => {
  for (const file of ['.github/workflows/app-ci.yml', 'package.json', 'package-lock.json', '.nvmrc']) {
    const flags = classify([file, 'docs/RELEASE.md']);
    assert.deepEqual(on(flags).filter(name => !['workflows', 'docs_only'].includes(name)), ['all', 'app', 'browser', 'db', 'functions', 'scripts', 'static_analysis'], file);
    assert.equal(flags.docs_only, false);
  }
  assert.equal(classify(['.github/workflows/app-ci.yml']).workflows, true);
  assert.equal(classify(['package.json']).workflows, false);
});

test('an unrecognised path is not trusted to be safe', () => {
  assert.equal(classify(['mystery/file.bin']).all, true);
  assert.equal(classify(['docs/RELEASE.md', 'mystery.txt']).db, true);
});

test('pushes, manual runs and an empty or failed diff run everything', () => {
  for (const event of ['push', 'workflow_dispatch', 'schedule']) {
    const flags = classify(['docs/RELEASE.md'], { event });
    assert.equal(flags.all, true, event);
    assert.equal(flags.secrets, true, event);
    assert.equal(flags.static_analysis, true, event);
  }
  assert.equal(classify([]).all, true);
});

test('a lockfile-only or audit-policy-only pull request routes to quality', () => {
  assert.equal(classify(['package-lock.json']).app, true);
  assert.deepEqual(on(classify(['docs/policy/npm-audit-allowlist.json'])), ['scripts', 'static_analysis']);
});
