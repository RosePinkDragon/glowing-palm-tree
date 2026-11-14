import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { BRANCH, evaluate, linkedIssue } from './delivery-policy.mjs';

// Arguments are passed directly to executables; command output is never included in errors.
function execute(command, args, cwd) {
  try { return execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch { throw new Error(`${command} ${args[0]} failed; verify repository access and retry.`); }
}
function json(run, args) {
  try { return JSON.parse(run('gh', args)); }
  catch { throw new Error('GitHub metadata unavailable or invalid; preflight cannot proceed.'); }
}
export function preflight(args, { cwd = process.cwd(), execute: command = execute } = {}) {
  if (args.length !== 4 || args[0] !== '--issue' || !/^[1-9][0-9]*$/.test(args[1]) || args[2] !== '--base' || args[3] !== 'main') {
    throw new Error('Usage: npm run pr:preflight -- --issue N --base main (only main is allowed).');
  }
  const issueNumber = Number(args[1]);
  if (!Number.isSafeInteger(issueNumber)) throw new Error('Issue number is invalid.');
  const run = (name, argv) => command(name, argv, cwd).trimEnd();
  const origin = run('git', ['remote', 'get-url', 'origin']);
  const remote = origin.match(/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/);
  if (!remote) throw new Error('Origin must identify an unambiguous GitHub repository.');
  const repository = `${remote[1]}/${remote[2]}`;
  const metadata = json(run, ['api', `repos/${repository}`]);
  if (typeof metadata.full_name !== 'string' || metadata.full_name.toLowerCase() !== repository.toLowerCase()) {
    throw new Error('GitHub repository identity does not match origin.');
  }
  run('git', ['fetch', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main']);
  const branch = run('git', ['symbolic-ref', '--short', 'HEAD']);
  const match = branch.match(BRANCH);
  if (!match || Number(match[3]) !== issueNumber) throw new Error('Branch must use an allowed scope and match the requested issue.');
  if (run('git', ['status', '--porcelain']).length) throw new Error('Commit or preserve working tree changes before preflight.');
  try { run('git', ['merge-base', '--is-ancestor', 'refs/remotes/origin/main', 'HEAD']); }
  catch { throw new Error('Current origin/main must be an ancestor of HEAD; update/rebase from main first.'); }
  const diff = run('git', ['diff', '--name-status', '-z', '--find-renames', 'refs/remotes/origin/main...HEAD']);
  const tokens = diff.split('\0');
  if (tokens.at(-1) === '') tokens.pop();
  const files = [];
  while (tokens.length) {
    const status = tokens.shift();
    const first = tokens.shift();
    const renamed = /^R[0-9]+$/.test(status);
    const second = renamed ? tokens.shift() : undefined;
    if (!/^(?:[AMDTUXB]|R[0-9]+)$/.test(status) || !first || (renamed && !second)) throw new Error('Unable to parse complete main-relative diff.');
    files.push(renamed ? { filename: second, previous_filename: first } : { filename: first });
  }
  const issue = json(run, ['api', `repos/${repository}/issues/${issueNumber}`]);
  const result = evaluate({ head: { ref: branch }, body: `Issue: #${issueNumber}` }, issue, files, repository);
  if (result.errors.length) throw new Error(result.errors.join('\n'));
  const pulls = [];
  for (let page = 1; ; page++) {
    if (page > 100) throw new Error('Open PR pagination exceeds the safety limit; metadata may be incomplete.');
    const entries = json(run, ['api', `repos/${repository}/pulls?state=open&per_page=100&page=${page}`]);
    if (!Array.isArray(entries) || entries.length > 100) throw new Error('Incomplete open PR metadata.');
    pulls.push(...entries);
    if (entries.length < 100) break;
  }
  for (const pr of pulls) {
    if (!Number.isSafeInteger(pr.number) || pr.state !== 'open' || typeof pr.body !== 'string' && pr.body !== null ||
        typeof pr.head?.ref !== 'string' || typeof pr.head?.repo?.full_name !== 'string' || typeof pr.base?.ref !== 'string') {
      throw new Error('Incomplete open PR metadata.');
    }
    const sameHead = pr.head.ref === branch && pr.head.repo.full_name.toLowerCase() === repository.toLowerCase();
    const branchIssue = pr.head.ref.match(BRANCH)?.[3];
    const sameIssue = Number(branchIssue) === issueNumber || linkedIssue(pr.body, repository) === issueNumber;
    if (sameHead && pr.base.ref !== 'main') throw new Error('The existing PR must target main before it can be updated.');
    if (sameIssue && !sameHead) throw new Error(`Open PR #${pr.number} belongs to this issue; merge the predecessor before publishing another slice.`);
  }
  return { branch, repository, issue: issueNumber, base: 'main', count: result.count };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = preflight(process.argv.slice(2));
    console.log(`Preflight passed: ${result.branch} -> main; ${result.count}/15 reviewable files for issue #${result.issue}.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
