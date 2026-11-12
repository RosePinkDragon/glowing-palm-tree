import test from 'node:test';
import assert from 'node:assert/strict';
import { BRANCH, evaluate, linkedIssue } from './delivery-policy.mjs';
import { createRunner } from './run-delivery-policy.mjs';

const repo = 'owner/repo';
const issue = () => ({ number: 3, state: 'open', labels: [{ name: 'enhancement' }, { name: 'approved' }], body: '' });
const pr = (number = 7, sha = 'head') => ({ number, state: 'open', head: { sha, ref: 'feature/monorepo-3-fix', repo: { id: 2 } }, base: { sha: 'base', ref: 'main', repo: { id: 1 } }, body: 'Issue: #3', draft: false, changed_files: 1 });
const files = [{ filename: 'src/code.js' }];
const err = (p, i, f = files) => evaluate(p, i, f, repo).errors;
const event = { repository: { default_branch: 'main' } };
const response = (data, status = 200, link = '') => new Response(JSON.stringify(data), { status, headers: link ? { link } : {} });

function fixture(options = {}) {
  const calls = [], checks = [];
  const list = options.prs || [pr()];
  let reads = 0, issueReads = 0, nextId = 1;
  const fetchImpl = async (url, init) => {
    const u = new URL(url), path = u.pathname;
    calls.push({ path, method: init.method, payload: init.body && JSON.parse(init.body), auth: init.headers.Authorization });
    if (path.endsWith('/check-runs') && init.method === 'POST') { const id = nextId++; checks.push({ id, head: JSON.parse(init.body).head_sha }); return response({ id }); }
    if (/\/check-runs\/\d+$/.test(path) && init.method === 'PATCH') return response({});
    if (path.endsWith('/pulls') && u.searchParams.get('state') === 'open') return options.listFailure ? response({}, 503) : response(list);
    const pm = path.match(/\/pulls\/(\d+)$/);
    if (pm) {
      reads++;
      if (options.failPr === Number(pm[1]) || options.failRead === reads) return response({}, 503);
      const found = structuredClone(list.find(p => p.number === Number(pm[1])));
      if (options.changePr && reads === 2) options.changePr(found);
      return response(found);
    }
    if (path.endsWith('/files')) return response(options.files || files);
    if (path.endsWith('/issues/3')) {
      issueReads++;
      const value = issue();
      if (options.changeIssue && issueReads > 1) value.labels = [];
      return response(value);
    }
    throw new Error('Unexpected test request: ' + path);
  };
  const runner = createRunner({ repository: repo, event: options.event || event, token: 'test-token', fetchImpl, revision: () => 'base', evaluator: options.evaluator });
  return { runner, calls, checks };
}

test('branch rules and feature approval independent of prefix', () => {
  for (const value of ['feature/ammu-sammu-customer-2-add-cart', 'bug/konkan-fine-dine-admin-15-fix', 'release/monorepo-1-ship']) assert.match(value, BRANCH);
  for (const value of ['Feature/monorepo-3-x', 'feature/monorepo-03-x', 'feature/other-3-x', 'feature/monorepo-3-X', 'feature/monorepo-3-x--y', 'feature/monorepo-0-x']) assert.doesNotMatch(value, BRANCH);
  assert.deepEqual(err(pr(), issue()), []);
  for (const prefix of ['feature', 'bug', 'release']) {
    const p = pr(), i = issue(); p.head.ref = `${prefix}/monorepo-3-fix`; i.labels = [{ name: 'enhancement' }, { name: 'bug' }];
    assert.ok(err(p, i).some(e => e.includes('Feature')));
  }
  const i = issue(); i.labels = [{ name: 'bug' }]; i.body = '## Assessment\nsmall\n## Small blast radius\nOnly one admin page affected.';
  assert.ok(err(pr(), i).length);
});

test('exactly one complete issue field, same repository, actual open issue', () => {
  assert.equal(linkedIssue('Issue: https://github.com/owner/repo/issues/3', repo), 3);
  for (const body of ['fixes #3', 'Issue:\n#3', 'Issue: #3\nIssue:', 'Issue: #3\nIssue: garbage', 'Issue: #3\nIssue: #4', 'Issue: https://github.com/other/repo/issues/3', 'Issue: #03']) assert.equal(linkedIssue(body, repo), null);
  const i = issue(); i.state = 'closed'; assert.ok(err(pr(), i).length);
  i.state = 'open'; i.pull_request = {}; assert.ok(err(pr(), i).length);
  const p = pr(); p.head.ref = 'feature/monorepo-4-fix'; assert.ok(err(p, issue()).length);
});

test('bug assessment accepts small OR understood, rejects placeholders and accepts known impact', () => {
  const p = pr(); p.head.ref = 'bug/monorepo-3-fix'; const i = issue(); i.labels = [{ name: 'bug' }];
  for (const value of ['', '<!-- explain -->', 'No', '- [ ]', 'unknown']) { i.body = `## Assessment\nsmall\n## Small blast radius\n${value}`; assert.ok(err(p, i).length); }
  i.body = '## Assessment\nsmall\n## Small blast radius\nOnly the admin report is affected.'; assert.deepEqual(err(p, i), []);
  i.body = '## Assessment\nunderstood\n## Reproduction\nNot yet investigated.\n## Impacts\nNot understood.'; assert.ok(err(p, i).length);
  i.body = '## Assessment\nunderstood\n## Reproduction\nOpen the admin report with an unknown customer ID.\n## Impacts\nExport is not available to admin users.'; assert.deepEqual(err(p, i), []);
  i.labels = []; assert.ok(err(p, i).length); i.labels = [{ name: 'approved' }]; assert.deepEqual(err(p, i), []);
});

test('reviewable count includes rename source and excludes only named files', () => {
  const f = Array.from({ length: 15 }, (_, n) => ({ filename: `src/${n}.js` }));
  f.push({ filename: 'sub/README.md' }, { filename: 'yarn.lock' }); assert.deepEqual(err(pr(), issue(), f), []);
  f.push({ filename: 'README.md', previous_filename: 'src/code.js' }); assert.ok(err(pr(), issue(), f).length);
  assert.ok(err(pr(), issue(), Array.from({ length: 16 }, (_, n) => ({ filename: `generated/${n}.js` }))).length);
});

test('full runner posts pending then patches the same check with successful verdict', async () => {
  const { runner, calls } = fixture({ changePr: p => { p.base.repo.updated_at = 'later'; } });
  await runner.runBatch();
  const checks = calls.filter(c => c.path.includes('check-runs'));
  assert.equal(checks[0].method, 'POST'); assert.equal(checks[0].payload.status, 'in_progress');
  assert.equal(checks[1].path, '/repos/owner/repo/check-runs/1'); assert.equal(checks[1].method, 'PATCH'); assert.equal(checks[1].payload.conclusion, 'success');
  assert.ok(calls.every(c => c.auth === 'Bearer test-token'));
});

test('initial, evaluation and final metadata failures complete started check as failure', async () => {
  for (const options of [{ failRead: 1 }, { evaluator: () => { throw new Error('evaluator failed'); } }, { failRead: 2 }, { files: [] }]) {
    const { runner, calls } = fixture(options); await assert.rejects(runner.runBatch());
    const check = calls.find(c => c.method === 'PATCH'); assert.equal(check.path, '/repos/owner/repo/check-runs/1'); assert.equal(check.payload.conclusion, 'failure');
  }
});

test('issue and PR body changes fail, volatile repo metadata is ignored', async () => {
  for (const options of [{ changeIssue: true }, { changePr: p => { p.body = 'Issue: #4'; } }]) {
    const { runner, calls } = fixture(options); await runner.runBatch(); assert.equal(calls.find(c => c.method === 'PATCH').payload.conclusion, 'failure');
  }
});

test('shared head including fork is rejected and failures do not prevent other PRs', async () => {
  const a = pr(1, 'same'), b = pr(2, 'same'), c = pr(3, 'different'); b.head.repo.id = 99;
  const { runner, calls } = fixture({ prs: [a, b, c] }); await assert.rejects(runner.runBatch());
  const patched = calls.filter(c => c.method === 'PATCH'); assert.equal(patched.length, 3);
  assert.equal(patched[0].payload.conclusion, 'failure'); assert.equal(patched[1].payload.conclusion, 'failure'); assert.equal(patched[2].payload.conclusion, 'success');
});

test('event check starts before failing open PR scan', async () => {
  const { runner, calls } = fixture({ event: { ...event, pull_request: pr() }, listFailure: true }); await assert.rejects(runner.runBatch());
  assert.equal(calls[0].payload.status, 'in_progress'); assert.equal(calls.at(-1).payload.conclusion, 'failure');
});

test('stale event head check fails and current head gets its own check', async () => {
  const { runner, calls } = fixture({ event: { ...event, pull_request: pr(7, 'old') }, prs: [pr(7, 'new')] }); await runner.runBatch();
  const checks = calls.filter(c => c.path.includes('check-runs'));
  assert.equal(checks[0].payload.head_sha, 'old'); assert.equal(checks[1].payload.conclusion, 'failure');
  assert.equal(checks[2].payload.head_sha, 'new'); assert.equal(checks[3].payload.conclusion, 'success');
});

test('pagination follows next and rejects foreign, malformed, truncated and non-list data', async () => {
  let n = 0;
  let runner = createRunner({ repository: repo, event, token: 'test', fetchImpl: async () => ++n === 1 ? response(Array(100).fill(1), 200, '<https://api.github.com/page2>; rel="next"') : response([2]) });
  assert.equal((await runner.pages('/pages')).length, 101);
  for (const link of ['<https://evil.example/page>; rel="next"', 'invalid', '<https://api.github.com/a>; rel="next", <https://api.github.com/b>; rel="next"']) {
    runner = createRunner({ repository: repo, event, token: 'test', fetchImpl: async () => response([], 200, link) });
    await assert.rejects(runner.pages('/pages'));
  }
  runner = createRunner({ repository: repo, event, token: 'test', fetchImpl: async () => response([], 200, '<https://api.github.com/a>; rel="next"') });
  await assert.rejects(runner.pages('/pages'), /Pagination limit/);
  runner = createRunner({ repository: repo, event, token: 'test', fetchImpl: async () => response({}) });
  await assert.rejects(runner.pages('/pages'), /Expected paginated list/);
  runner = createRunner({ repository: repo, event, token: 'test', fetchImpl: async () => new Response('bad json') });
  await assert.rejects(runner.pages('/pages'));
});

test('GitHub file limit is rejected even when reported count matches', async () => {
  const p = pr(); p.changed_files = 3000;
  const { runner, calls } = fixture({ prs: [p], files: Array.from({ length: 3000 }, (_, n) => ({ filename: `${n}.js` })) });
  await assert.rejects(runner.runBatch()); assert.match(calls.find(c => c.method === 'PATCH').payload.output.summary, /3000-file limit/);
});
