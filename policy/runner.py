"""Run trusted-base policy against live GitHub API data and publish check runs."""
import json
import os
import re
import subprocess
import urllib.error
import urllib.parse
import urllib.request

from evaluator import BRANCH, evaluate, linked_issue

API = os.environ.get('GITHUB_API_URL', 'https://api.github.com')
REPO = ''
EVENT = {}
HEADERS = {}


def request(path, data=None):
    url = path if path.startswith('https://') else API + path
    if not url.startswith(API + '/'):
        raise RuntimeError('Unexpected pagination URL')
    payload = json.dumps(data).encode() if data is not None else None
    req = urllib.request.Request(url, data=payload, headers=HEADERS, method='POST' if data is not None else 'GET')
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


def publish(pr, errors, count):
    sha = pr['head']['sha']
    # Avoid reporting a result for an outdated revision or base/event state.
    current = get_pr(pr['number'])
    if current['state'] != 'open' or current['head']['sha'] != sha:
        print(f"PR {pr['number']} closed or its head changed during evaluation")
        return
    if current['base'] != pr['base'] or current['head']['ref'] != pr['head']['ref'] or current.get('body') != pr.get('body') or current.get('draft') != pr.get('draft'):
        errors = ['PR metadata changed during evaluation; rerun if a subsequent event does not update this check.']
    text = '\n'.join('- ' + e for e in errors) if errors else f'All policy checks passed. Reviewable files: {count}/15.'
    request(f'/repos/{REPO}/check-runs', {'name': 'Delivery policy', 'head_sha': sha, 'status': 'completed', 'conclusion': 'failure' if errors else 'success', 'output': {'title': 'Delivery policy failed' if errors else 'Delivery policy passed', 'summary': text[:65000]}})


def process(number):
    pr = get_pr(number)
    if pr['state'] != 'open':
        return
    errors = []
    count = 0
    issue = None
    try:
        trusted = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()
        if pr['base']['sha'] != trusted:
            raise RuntimeError('Trusted checkout does not match the current PR base; rerun the workflow.')
        if pr['base']['ref'] != EVENT['repository']['default_branch']:
            raise RuntimeError('Delivery policy requires the default branch as the PR base.')
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
    except Exception as exc:
        errors = ['Policy could not verify this PR: ' + str(exc)]
    if issue:
        try:
            fresh = request(f'/repos/{REPO}/issues/{issue["number"]}')[0]
            if (fresh.get('state'), fresh.get('body'), fresh.get('labels')) != (issue.get('state'), issue.get('body'), issue.get('labels')):
                errors = ['Issue changed during evaluation; rerun if a subsequent event does not update this check.']
        except Exception as exc:
            errors = ['Could not recheck issue state: ' + str(exc)]
    publish(pr, errors, count)


def main():
    global REPO, EVENT, HEADERS
    REPO = os.environ['GITHUB_REPOSITORY']
    with open(os.environ['GITHUB_EVENT_PATH'], encoding='utf-8') as event_file:
        EVENT = json.load(event_file)
    HEADERS = {'Authorization': 'Bearer ' + os.environ['GITHUB_TOKEN'], 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28'}
    if 'pull_request' in EVENT:
        process(EVENT['pull_request']['number'])
    elif 'issue' in EVENT and 'pull_request' not in EVENT['issue']:
        number = EVENT['issue']['number']
        for pr in pages(f'/repos/{REPO}/pulls?state=open&base=' + urllib.parse.quote(EVENT['repository']['default_branch'], safe='')):
            branch = BRANCH.fullmatch(pr['head']['ref'])
            if (branch and int(branch.group(3)) == number) or linked_issue(pr.get('body'), REPO) == number:
                process(pr['number'])


if __name__ == '__main__':
    main()
