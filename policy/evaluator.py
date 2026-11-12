"""Pure delivery policy; inputs are GitHub API data, never pull request code."""
import re

SCOPES = r'(?:ammu-sammu-(?:customer|admin)|konkan-fine-dine-(?:customer|admin)|monorepo)'
BRANCH = re.compile(rf'^(feature|bug|release)/({SCOPES})-([1-9][0-9]*)-([a-z0-9]+(?:-[a-z0-9]+)*)$')
LOCKFILES = {'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb', 'Cargo.lock', 'Pipfile.lock', 'poetry.lock', 'uv.lock', 'Gemfile.lock', 'composer.lock', 'go.sum'}


def reviewable(path):
    name = path.rsplit('/', 1)[-1]
    return name not in LOCKFILES and name not in {'.gitignore', 'README', 'README.md', 'README.rst', 'README.txt'}


def linked_issue(body, repository):
    fields = [line for line in (body or '').splitlines() if re.match(r'^[ \t]*Issue:', line)]
    if len(fields) != 1:
        return None
    field = re.fullmatch(r'[ \t]*Issue:[ \t]*(\S+)[ \t]*', fields[0])
    if not field:
        return None
    value = field.group(1)
    match = re.fullmatch(r'#([1-9][0-9]*)', value)
    if not match:
        match = re.fullmatch(r'https://github\.com/' + re.escape(repository) + r'/issues/([1-9][0-9]*)/?', value)
    return int(match.group(1)) if match else None


def section(body, heading):
    matches = re.findall(r'^#{2,4}[ \t]+' + re.escape(heading) + r'[ \t]*\n(.*?)(?=^#{2,4}[ \t]|\Z)', body or '', re.MULTILINE | re.DOTALL | re.IGNORECASE)
    if len(matches) != 1:
        return ''
    return re.sub(r'<!--.*?-->', '', matches[0], flags=re.DOTALL).strip()


def rationale(body, heading):
    value = section(body, heading)
    # Reject common placeholders and checkbox-only answers; reviewers judge substance.
    value = re.sub(r'(?m)^\s*[-*]\s*\[[ xX]\]\s*', '', value).strip()
    if len(re.findall(r'[A-Za-z0-9]+', value)) < 3:
        return False
    return not re.fullmatch(r'(?:unknown|unsure|unclear|uninvestigated|tbd|todo|n/a|not (?:yet |currently )?(?:known|understood|investigated|available|determined|sure))[.!?]*', value, re.IGNORECASE)


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
                choice = section(body, 'Assessment').lower()
                small = choice == 'small' and rationale(body, 'Small blast radius')
                understood = choice == 'understood' and rationale(body, 'Reproduction') and rationale(body, 'Impacts')
                if not (small or understood):
                    errors.append('Bug issues need a documented small blast radius or both reproduction and understood impacts, or the approved label.')
    count = sum(1 for f in files if reviewable(f.get('filename', '')) or (f.get('previous_filename') and reviewable(f['previous_filename'])))
    if count > 15:
        errors.append(f'{count} reviewable files exceed the limit of 15.')
    return errors, count
