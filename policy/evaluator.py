"""Pure delivery policy; inputs are GitHub API data, never pull request code."""
import re

SCOPES = r'(?:ammu-sammu-(?:customer|admin)|konkan-fine-dine-(?:customer|admin)|monorepo)'
BRANCH = re.compile(rf'^(feature|bug|release)/({SCOPES})-([1-9][0-9]*)-([a-z0-9]+(?:-[a-z0-9]+)*)$')
LOCKFILES = {'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb', 'Cargo.lock', 'Pipfile.lock', 'poetry.lock', 'uv.lock', 'Gemfile.lock', 'composer.lock', 'go.sum'}


def reviewable(path):
    name = path.rsplit('/', 1)[-1]
    return name not in LOCKFILES and name not in {'.gitignore', 'README', 'README.md', 'README.rst', 'README.txt'}


def linked_issue(body, repository):
    # Exactly one explicit field prevents ambiguous or incidental references.
    fields = re.findall(r'^Issue:\s*(\S+)\s*$', body or '', re.MULTILINE)
    if len(fields) != 1:
        return None
    value = fields[0]
    match = re.fullmatch(r'#([1-9][0-9]*)', value)
    if not match:
        match = re.fullmatch(r'https://github\.com/' + re.escape(repository) + r'/issues/([1-9][0-9]*)/?', value)
    return int(match.group(1)) if match else None


def filled_section(body, heading):
    match = re.search(r'^#{2,4}\s*' + re.escape(heading) + r'\s*\n(.*?)(?=^#{2,4}\s|\Z)', body or '', re.MULTILINE | re.DOTALL | re.IGNORECASE)
    if not match:
        return False
    content = re.sub(r'<!--.*?-->', '', match.group(1), flags=re.DOTALL).strip()
    return bool(content and content.lower() not in {'n/a', 'none', 'unknown', 'tbd', 'todo', '-'} )


def evaluate(pr, issue, files, repository):
    errors = []
    branch = BRANCH.fullmatch(pr.get('head', {}).get('ref', ''))
    if not branch:
        errors.append('Branch must be (feature|bug|release)/<allowed-scope>-<positive issue number>-<lowercase-short-desc>.')
    number = linked_issue(pr.get('body'), repository)
    if number is None:
        errors.append('Provide exactly one Issue: #N or Issue: https://github.com/OWNER/REPO/issues/N line.')
    if branch and number != int(branch.group(3)):
        errors.append('Branch issue number must match the linked issue.')
    if not issue or 'pull_request' in issue or issue.get('number') != number:
        errors.append('The linked issue must exist in this repository and be an issue, not a pull request.')
    else:
        if issue.get('state') != 'open':
            errors.append('The linked issue must be open.')
        labels = {x.get('name', '') for x in issue.get('labels', [])}
        approved = 'approved' in labels
        feature = bool(branch and branch.group(1) == 'feature') or bool(labels & {'enhancement', 'feature'})
        bug = 'bug' in labels
        if feature and not approved:
            errors.append('Feature issues require the exact approved label before work, regardless of branch prefix.')
        elif not feature and not approved:
            if not bug:
                errors.append('Unclassified issues require the approved label.')
            else:
                body = issue.get('body') or ''
                small = filled_section(body, 'Small blast radius')
                understood = filled_section(body, 'Reproduction') and filled_section(body, 'Impacts')
                if not (small or understood):
                    errors.append('Bug issues need a documented small blast radius or both reproduction and understood impacts, or the approved label.')
    count = sum(1 for f in files if reviewable(f.get('filename', '')) or (f.get('previous_filename') and reviewable(f['previous_filename'])))
    if count > 15:
        errors.append(f'{count} reviewable files exceed the limit of 15.')
    return errors, count
