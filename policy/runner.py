"""Run trusted-base policy against live GitHub API data and publish check runs."""
import json
import os
import re
import subprocess
import urllib.error
import urllib.request
from collections import Counter

from evaluator import evaluate, linked_issue

API = os.environ.get('GITHUB_API_URL', 'https://api.github.com')
REPO = ''
EVENT = {}
HEADERS = {}


def request(path, data=None, method=None):
    url = path if path.startswith('https://') else API + path
    if not url.startswith(API + '/'):
        raise RuntimeError('Unexpected pagination URL')
    payload = json.dumps(data).encode() if data is not None else None
    req = urllib.request.Request(url, data=payload, headers=HEADERS, method=method or ('POST' if data is not None else 'GET'))
    with urllib.request.urlopen(req, timeout=30) as response:
        return json.load(response), response.headers.get('Link', '')


def pages(path):
    results = []
    url = path + ('&' if '?' in path else '?') + 'per_page=100'
    for _ in range(100):
        batch, link = request(url)
        if not isinstance(batch, list):
            raise RuntimeError('Expected paginated list')
        results.extend(batch)
        next_links = re.findall(r'<([^>]+)>;\s*rel="next"', link)
        if not next_links:
            return results
        if len(next_links) != 1:
            raise RuntimeError('Ambiguous pagination')
        url = next_links[0]
    raise RuntimeError('Pagination limit reached; refusing truncated data')


def get_pr(number):
    return request(f'/repos/{REPO}/pulls/{number}')[0]


def start_check(pr):
    return request(f'/repos/{REPO}/check-runs', {'name': 'Delivery policy', 'head_sha': pr['head']['sha'], 'status': 'in_progress'})[0]['id']


def finish_check(check_id, errors, count=0):
    text = '\n'.join('- ' + e for e in errors) if errors else f'All policy checks passed. Reviewable files: {count}/15.'
    request(f'/repos/{REPO}/check-runs/{check_id}', {'status': 'completed', 'conclusion': 'failure' if errors else 'success', 'output': {'title': 'Delivery policy failed' if errors else 'Delivery policy passed', 'summary': text[:65000]}}, method='PATCH')


def stable_metadata(pr):
    def ref(side):
        part = pr[side]
        return part['ref'], part['sha'], (part.get('repo') or {}).get('id')
    return pr['state'], ref('head'), ref('base'), pr.get('body'), pr.get('draft')


def process(snapshot, check_id, shared):
    number = snapshot['number']
    sha = snapshot['head']['sha']
    errors = []
    count = 0
    technical_failure = False
    try:
        pr = get_pr(number)
        if pr['state'] != 'open' or pr['head']['sha'] != sha:
            finish_check(check_id, ['PR closed or head changed during evaluation.'])
            return
        if shared:
            raise RuntimeError('Multiple open PRs share this head commit; each open PR needs a distinct head commit.')
        trusted = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()
        if pr['base']['ref'] != EVENT['repository']['default_branch'] or pr['base']['sha'] != trusted:
            raise RuntimeError('PR must target the checked-out current default branch; rerun after its base changes.')
        files = pages(f'/repos/{REPO}/pulls/{number}/files')
        if len(files) != pr['changed_files'] or len(files) >= 3000:
            raise RuntimeError('File list is incomplete or at the GitHub API 3000-file limit.')
        linked = linked_issue(pr.get('body'), REPO)
        issue = None
        if linked:
            try:
                issue = request(f'/repos/{REPO}/issues/{linked}')[0]
            except urllib.error.HTTPError as exc:
                if exc.code != 404:
                    raise
        errors, count = evaluate(pr, issue, files, REPO)
        if issue:
            fresh = request(f'/repos/{REPO}/issues/{issue["number"]}')[0]
            if (fresh.get('state'), fresh.get('body'), fresh.get('labels')) != (issue.get('state'), issue.get('body'), issue.get('labels')):
                errors = ['Issue changed during evaluation; rerun if a subsequent event does not update this check.']
        current = get_pr(number)
        if stable_metadata(current) != stable_metadata(pr):
            errors = ['PR metadata changed during evaluation; rerun if a subsequent event does not update this check.']
    except Exception as exc:
        errors = ['Policy could not verify this PR: ' + str(exc)]
        technical_failure = True
    finish_check(check_id, errors, count)
    return not technical_failure


def run_batch():
    # Start the event PR before the list request, so a list failure does not preserve success.
    started = {}
    failures = []
    event_pr = EVENT.get('pull_request')
    if event_pr and event_pr.get('state') == 'open':
        try:
            started[event_pr['number']] = (event_pr, start_check(event_pr))
        except Exception as exc:
            failures.append(f"PR {event_pr['number']}: could not start check: {exc}")
    try:
        prs = pages(f'/repos/{REPO}/pulls?state=open')
    except Exception as exc:
        for snapshot, check_id in started.values():
            try:
                finish_check(check_id, ['Could not list open PRs: ' + str(exc)])
            except Exception as finish_exc:
                failures.append(str(finish_exc))
        raise RuntimeError('Could not list open PRs: ' + str(exc)) from exc
    listed_numbers = {pr['number'] for pr in prs}
    for number in set(started) - listed_numbers:
        try:
            finish_check(started[number][1], ['PR is no longer open.'])
        except Exception as exc:
            failures.append(f'PR {number}: {exc}')
    counts = Counter(pr['head']['sha'] for pr in prs)
    for pr in prs:
        number = pr['number']
        if number in started and started[number][0]['head']['sha'] != pr['head']['sha']:
            try:
                finish_check(started[number][1], ['PR head changed before evaluation.'])
            except Exception as exc:
                failures.append(f'PR {number}: {exc}')
            del started[number]
        if number not in started:
            try:
                started[number] = (pr, start_check(pr))
            except Exception as exc:
                failures.append(f'PR {number}: could not start check: {exc}')
    for pr in prs:
        if pr['number'] not in started:
            continue
        try:
            if process(pr, started[pr['number']][1], counts[pr['head']['sha']] > 1) is False:
                failures.append(f"PR {pr['number']}: evaluation failed")
        except Exception as exc:
            failures.append(f"PR {pr['number']}: could not complete check: {exc}")
    if failures:
        raise RuntimeError('; '.join(failures))


def main():
    global REPO, EVENT, HEADERS
    REPO = os.environ['GITHUB_REPOSITORY']
    with open(os.environ['GITHUB_EVENT_PATH'], encoding='utf-8') as event_file:
        EVENT = json.load(event_file)
    HEADERS = {'Authorization': 'Bearer ' + os.environ['GITHUB_TOKEN'], 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28'}
    run_batch()


if __name__ == '__main__':
    main()
