import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { evaluate, linkedIssue } from './delivery-policy.mjs';

export function createRunner({ repository, event, token, api = 'https://api.github.com', fetchImpl = fetch, evaluator = evaluate }) {
  const apiBase = api.replace(/\/$/, '');
  async function request(path, data, method = data === undefined ? 'GET' : 'POST') {
    const url = path.startsWith('https://') ? path : apiBase + path;
    if (!url.startsWith(apiBase + '/')) throw new Error('Unexpected pagination URL');
    const response = await fetchImpl(url, { method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }), signal: AbortSignal.timeout(30000), redirect: 'error' });
    if (!response.ok) { const err = new Error(`GitHub API request failed (${response.status})`); err.status = response.status; throw err; }
    return { data: await response.json(), link: response.headers.get('link') || '' };
  }
  async function pages(path) {
    let url = path + (path.includes('?') ? '&' : '?') + 'per_page=100';
    const results = [];
    for (let i = 0; i < 100; i++) {
      const { data, link } = await request(url);
      if (!Array.isArray(data)) throw new Error('Expected paginated list');
      results.push(...data);
      if (!link) return results;
      const parts = link.split(',').map(part => part.trim());
      const parsed = parts.map(part => part.match(/^<([^>]+)>;\s*rel="([^"]+)"$/));
      if (parsed.some(part => !part)) throw new Error('Malformed pagination link');
      const next = parsed.filter(part => part[2] === 'next');
      if (next.length > 1) throw new Error('Ambiguous pagination');
      if (!next.length) return results;
      url = next[0][1];
      if (!url.startsWith(apiBase + '/')) throw new Error('Unexpected pagination URL');
    }
    throw new Error('Pagination limit reached; refusing truncated data');
  }
  const getPr = async number => (await request(`/repos/${repository}/pulls/${number}`)).data;
  const startCheck = async pr => (await request(`/repos/${repository}/check-runs`, { name: 'Delivery policy', head_sha: pr.head.sha, status: 'in_progress' })).data.id;
  async function finishCheck(id, errors, count = 0) {
    const summary = errors.length ? errors.map(e => '- ' + e).join('\n') : `All policy checks passed. Reviewable files: ${count}/15.`;
    await request(`/repos/${repository}/check-runs/${id}`, { status: 'completed', conclusion: errors.length ? 'failure' : 'success', output: { title: errors.length ? 'Delivery policy failed' : 'Delivery policy passed', summary: summary.slice(0, 65000) } }, 'PATCH');
  }
  function stable(pr) {
    const ref = side => [pr[side].ref, pr[side].sha, pr[side].repo?.id ?? null];
    return JSON.stringify([pr.state, ref('head'), ref('base'), pr.body ?? null, pr.draft ?? null]);
  }
  async function process(snapshot, checkId, shared) {
    let errors = [], count = 0, technicalFailure = false;
    try {
      const pr = await getPr(snapshot.number);
      if (pr.state !== 'open' || pr.head.sha !== snapshot.head.sha) {
        await finishCheck(checkId, ['PR closed or head changed during evaluation.']);
        return true;
      }
      if (shared) throw new Error('Multiple open PRs share this head commit; each open PR needs a distinct head commit.');
      // GitHub retains a PR's base snapshot when unrelated commits land on main.
      // Workflow checkout supplies trusted policy code; target ref supplies scope.
      if (pr.base.ref !== event.repository.default_branch) throw new Error('PR must target the repository default branch.');
      const files = await pages(`/repos/${repository}/pulls/${pr.number}/files`);
      if (files.length !== pr.changed_files || files.length >= 3000) throw new Error('File list is incomplete or at the GitHub API 3000-file limit.');
      const number = linkedIssue(pr.body, repository);
      let issue = null;
      if (number) {
        try { issue = (await request(`/repos/${repository}/issues/${number}`)).data; }
        catch (err) { if (err.status !== 404) throw err; }
      }
      ({ errors, count } = evaluator(pr, issue, files, repository));
      if (issue) {
        const fresh = (await request(`/repos/${repository}/issues/${issue.number}`)).data;
        const fields = item => JSON.stringify([item.state, item.body, item.labels]);
        if (fields(fresh) !== fields(issue)) errors = ['Issue changed during evaluation; rerun if a subsequent event does not update this check.'];
      }
      const current = await getPr(pr.number);
      if (stable(current) !== stable(pr)) errors = ['PR metadata changed during evaluation; rerun if a subsequent event does not update this check.'];
    } catch (err) {
      errors = ['Policy could not verify this PR: ' + err.message];
      technicalFailure = true;
    }
    await finishCheck(checkId, errors, count);
    return !technicalFailure;
  }
  async function runBatch() {
    const started = new Map(), failures = [];
    const eventPr = event.pull_request;
    if (eventPr?.state === 'open') {
      try { started.set(eventPr.number, [eventPr, await startCheck(eventPr)]); }
      catch (err) { failures.push(`PR ${eventPr.number}: could not start check: ${err.message}`); }
    }
    let prs;
    try { prs = await pages(`/repos/${repository}/pulls?state=open`); }
    catch (err) {
      for (const [, id] of started.values()) { try { await finishCheck(id, ['Could not list open PRs: ' + err.message]); } catch {} }
      throw new Error('Could not list open PRs: ' + err.message);
    }
    const listed = new Set(prs.map(pr => pr.number));
    for (const [number, [, id]] of started) if (!listed.has(number)) {
      try { await finishCheck(id, ['PR is no longer open.']); } catch (err) { failures.push(`PR ${number}: ${err.message}`); }
    }
    const counts = new Map();
    for (const pr of prs) counts.set(pr.head.sha, (counts.get(pr.head.sha) || 0) + 1);
    for (const pr of prs) {
      let previous = started.get(pr.number);
      if (previous && previous[0].head.sha !== pr.head.sha) {
        try { await finishCheck(previous[1], ['PR head changed before evaluation.']); } catch (err) { failures.push(`PR ${pr.number}: ${err.message}`); }
        started.delete(pr.number); previous = null;
      }
      if (!previous) {
        try { started.set(pr.number, [pr, await startCheck(pr)]); }
        catch (err) { failures.push(`PR ${pr.number}: could not start check: ${err.message}`); }
      }
    }
    for (const pr of prs) {
      if (!started.has(pr.number)) continue;
      try { if (!await process(pr, started.get(pr.number)[1], counts.get(pr.head.sha) > 1)) failures.push(`PR ${pr.number}: evaluation failed`); }
      catch (err) { failures.push(`PR ${pr.number}: could not complete check: ${err.message}`); }
    }
    if (failures.length) throw new Error(failures.join('; '));
  }
  return { request, pages, startCheck, finishCheck, process, runBatch };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  try { await createRunner({ repository: process.env.GITHUB_REPOSITORY, event, token: process.env.GITHUB_TOKEN, api: process.env.GITHUB_API_URL }).runBatch(); }
  catch (err) { console.error(err.message); process.exitCode = 1; }
}
