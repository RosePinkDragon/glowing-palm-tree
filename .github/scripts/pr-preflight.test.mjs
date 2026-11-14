import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { preflight } from './pr-preflight.mjs';

const branch = 'feature/monorepo-77-delivery';
const repository = 'example/project';
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pr-preflight-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, 'work');
  const upstream = join(root, 'origin');
  const git = (args, where = cwd) => execFileSync('git', args, { cwd: where, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  mkdirSync(upstream);
  git(['init', '--initial-branch=main'], upstream);
  git(['config', 'user.name', 'Test'], upstream);
  git(['config', 'user.email', 'test@example.com'], upstream);
  writeFileSync(join(upstream, 'initial.txt'), 'initial\n');
  git(['add', '.'], upstream);
  git(['commit', '-m', 'initial'], upstream);
  git(['clone', upstream, cwd], root);
  git(['config', 'user.name', 'Test']);
  git(['config', 'user.email', 'test@example.com']);
  git(['switch', '-c', branch]);
  const calls = [];
  const state = { prs: [[]], issue: { number: 77, state: 'open', labels: [{ name: 'approved' }] } };
  const execute = (name, args) => {
    calls.push([name, ...args]);
    if (state.failure?.(name, args)) throw new Error('simulated unavailable service');
    if (name === 'git') {
      if (args[0] === 'remote') return state.remote ?? 'https://github.com/example/project.git\n';
      return git(args);
    }
    if (args[1] === `repos/${repository}`) return JSON.stringify(state.metadata ?? { full_name: repository });
    if (args.includes(`repos/${repository}/issues/77`)) return JSON.stringify(state.issue);
    const page = Number(args[1].match(/&page=([0-9]+)$/)?.[1]);
    const entries = Array.isArray(state.prs) ? state.prs[page - 1] : state.prs;
    return typeof entries === 'string' ? entries : JSON.stringify(entries);
  };
  const commit = (paths, where = cwd) => {
    for (const path of paths) { mkdirSync(join(where, path, '..'), { recursive: true }); writeFileSync(join(where, path), `${path}\n`); }
    git(['add', '.'], where);
    git(['commit', '-m', 'change'], where);
  };
  return { cwd, upstream, git, state, calls, commit, run: (args = ['--issue', '77', '--base', 'main']) => preflight(args, { cwd, execute }) };
}
function pr(overrides = {}) {
  return { number: 81, state: 'open', body: 'Issue: #77', head: { ref: 'feature/monorepo-77-first', repo: { full_name: repository } }, base: { ref: 'main' }, ...overrides };
}
test('fresh-main comparison rejects 30 cumulative files even when local slice has only 15', t => {
  const f = fixture(t);
  f.commit(Array.from({ length: 15 }, (_, n) => `first-${n}.txt`));
  f.git(['branch', 'local-slice-base']);
  f.commit(Array.from({ length: 15 }, (_, n) => `second-${n}.txt`));
  assert.equal(f.git(['diff', '--name-only', 'local-slice-base...HEAD']).trim().split('\n').length, 15);
  assert.throws(() => f.run(), /30 reviewable files/);
  assert.ok(f.calls.some(call => call[1] === 'fetch' && call.includes('+refs/heads/main:refs/remotes/origin/main')));
});
test('fetch discovers main advancement and rejects a stale ancestor', t => {
  const f = fixture(t);
  f.commit(['feature.txt']);
  f.commit(['new-main.txt'], f.upstream);
  assert.throws(() => f.run(), /update\/rebase/);
  assert.equal(f.git(['rev-parse', 'origin/main']).trim(), f.git(['rev-parse', 'HEAD'], f.upstream).trim());
  f.git(['merge', '--no-edit', 'origin/main']);
  assert.equal(f.run().count, 1);
});
test('only main is accepted, with matching policy branch and issue', t => {
  const f = fixture(t);
  assert.throws(() => f.run(['--issue', '77', '--base', 'feature/monorepo-77-first']), /only main/);
  assert.throws(() => f.run(['--issue', '78', '--base', 'main']), /match the requested issue/);
  f.git(['switch', '-c', 'feature/not-allowed-77-change']);
  assert.throws(() => f.run(), /allowed scope/);
});
test('open predecessor blocks; same head update and unrelated issue are allowed', t => {
  const f = fixture(t);
  f.state.prs = [[pr()]];
  assert.throws(() => f.run(), /merge the predecessor/);
  f.state.prs = [[pr({ body: 'Issue: #78' })]]; // Branch still identifies issue 77.
  assert.throws(() => f.run(), /merge the predecessor/);
  f.state.prs = [[pr({ head: { ref: branch, repo: { full_name: repository } } })]];
  assert.equal(f.run().count, 0);
  f.state.prs = [[pr({ body: 'Issue: #78', head: { ref: 'feature/monorepo-78-other', repo: { full_name: repository } } })]];
  assert.equal(f.run().count, 0);
  f.state.prs = [[pr({ head: { ref: branch, repo: { full_name: 'fork/project' } } })]];
  assert.throws(() => f.run(), /merge the predecessor/);
  f.state.prs = [[pr({ head: { ref: branch, repo: { full_name: repository } }, base: { ref: 'other' } })]];
  assert.throws(() => f.run(), /must target main/);
});
test('lockfiles and README excluded, handwritten locks and renames counted on either path', t => {
  const f = fixture(t);
  f.commit(['package-lock.json', 'README.md', 'notes.lock', 'nested/README.txt', 'to-rename.txt'], f.upstream);
  f.git(['fetch', 'origin']);
  f.git(['merge', '--no-edit', 'origin/main']);
  f.git(['mv', 'to-rename.txt', 'README.rst']);
  f.git(['mv', 'README.md', 'from-readme.txt']);
  f.commit(['package-lock.json', 'nested/README.txt', 'notes.lock', '.gitignore', 'nested/yarn.lock']);
  assert.equal(f.run().count, 2); // Both renamed reviewable paths count; unchanged handwritten lock does not.
  writeFileSync(join(f.cwd, 'notes.lock'), 'handwritten change\n');
  f.git(['add', '.']); f.git(['commit', '-m', 'handwritten lock']);
  assert.equal(f.run().count, 3);
});
test('remote, fetch and GitHub failures, invalid metadata, issue approval and dirty state fail closed', t => {
  const f = fixture(t);
  for (const target of ['remote', 'fetch']) {
    f.state.failure = (name, args) => name === 'git' && args[0] === target;
    assert.throws(() => f.run());
  }
  f.state.failure = name => name === 'gh';
  assert.throws(() => f.run(), /metadata unavailable/);
  f.state.failure = null;
  f.state.remote = 'https://credential@github.com/example/project.git';
  assert.throws(() => f.run(), /unambiguous GitHub/);
  delete f.state.remote;
  f.state.metadata = { full_name: 'wrong/repository' };
  assert.throws(() => f.run(), /identity/);
  delete f.state.metadata;
  for (const prs of ['not json', {}, [], [[{ number: 3 }]]]) {
    f.state.prs = prs;
    assert.throws(() => f.run(), /metadata/);
  }
  f.state.prs = [[]];
  f.state.issue.labels = [];
  assert.throws(() => f.run(), /approved label/);
  f.state.issue.labels = [{ name: 'approved' }];
  writeFileSync(join(f.cwd, 'uncommitted.txt'), 'pending');
  assert.throws(() => f.run(), /working tree/);
});

test('pagination checks later-page predecessors and fails on incomplete later pages', t => {
  const f = fixture(t);
  const first = Array.from({ length: 100 }, (_, n) => pr({
    number: n + 100, body: 'Issue: #78',
    head: { ref: `feature/monorepo-78-independent-${n}`, repo: { full_name: repository } },
  }));
  f.state.prs = [first, [pr()]];
  assert.throws(() => f.run(), /merge the predecessor/);
  f.state.prs = [first, []];
  assert.equal(f.run().count, 0);
  assert.ok(f.calls.some(call => call[2]?.endsWith('&page=2')));
  for (const invalid of ['invalid json', {}, null]) {
    f.state.prs = [first, invalid];
    assert.throws(() => f.run(), /metadata/);
  }
  f.state.prs = [first, []];
  f.state.failure = (name, args) => name === 'gh' && args[1]?.endsWith('&page=2');
  assert.throws(() => f.run(), /metadata unavailable/);
  f.state.failure = null;
  f.state.prs = Array.from({ length: 100 }, () => first);
  assert.throws(() => f.run(), /pagination exceeds/);
});
