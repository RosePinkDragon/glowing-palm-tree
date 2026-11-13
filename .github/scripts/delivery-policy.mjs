const scopes = '(?:ammu-sammu-(?:customer|admin)|(?:konkan-fine-dine|kokani-dine-inn)-(?:customer|admin)|monorepo)';
export const BRANCH = new RegExp(`^(feature|bug|release)/(${scopes})-([1-9][0-9]*)-([a-z0-9]+(?:-[a-z0-9]+)*)$`);
const excluded = new Set(['.gitignore', 'README', 'README.md', 'README.rst', 'README.txt', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb', 'Cargo.lock', 'Pipfile.lock', 'poetry.lock', 'uv.lock', 'Gemfile.lock', 'composer.lock', 'go.sum']);
export const reviewable = path => !excluded.has(path.split('/').at(-1));

export function linkedIssue(body, repository) {
  const fields = (body || '').split(/\r?\n/).filter(line => /^[ \t]*Issue:/.test(line));
  if (fields.length !== 1) return null;
  const field = fields[0].match(/^[ \t]*Issue:[ \t]*(\S+)[ \t]*$/);
  if (!field) return null;
  const escaped = repository.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = field[1].match(/^#([1-9][0-9]*)$/) || field[1].match(new RegExp(`^https://github\\.com/${escaped}/issues/([1-9][0-9]*)/?$`));
  return match ? Number(match[1]) : null;
}

function section(body, heading) {
  const pattern = new RegExp(`^#{2,4}[ \\t]+${heading}[ \\t]*\\r?\\n([\\s\\S]*?)(?=^#{2,4}[ \\t]|(?![\\s\\S]))`, 'gmi');
  const matches = [...(body || '').matchAll(pattern)];
  return matches.length === 1 ? matches[0][1].replace(/<!--[\s\S]*?-->/g, '').trim() : '';
}
function rationale(body, heading) {
  const value = section(body, heading).replace(/^\s*[-*]\s*\[[ xX]\]\s*/gm, '').trim();
  if ((value.match(/[A-Za-z0-9]+/g) || []).length < 3) return false;
  return !/^(?:unknown|unsure|unclear|uninvestigated|tbd|todo|n\/a|not (?:yet |currently )?(?:known|understood|investigated|available|determined|sure))[.!?]*$/i.test(value);
}
export function evaluate(pr, issue, files, repository) {
  const errors = [];
  const branch = (pr.head?.ref || '').match(BRANCH);
  if (!branch) errors.push('Branch must be (feature|bug|release)/<allowed-scope>-<positive issue number>-<lowercase-short-desc>.');
  const number = linkedIssue(pr.body, repository);
  if (number === null) errors.push('Provide exactly one Issue: #N or Issue: https://github.com/OWNER/REPO/issues/N line.');
  if (branch && number !== Number(branch[3])) errors.push('Branch issue number must match the linked issue.');
  if (!issue || 'pull_request' in issue || issue.number !== number) errors.push('The linked issue must exist in this repository and be an issue, not a pull request.');
  else {
    if (issue.state !== 'open') errors.push('The linked issue must be open.');
    const labels = new Set((issue.labels || []).map(label => label.name));
    const approved = labels.has('approved');
    const feature = branch?.[1] === 'feature' || labels.has('feature') || labels.has('enhancement');
    if (feature && !approved) errors.push('Feature issues require the exact approved label before work, regardless of branch prefix.');
    else if (!feature && !approved) {
      if (!labels.has('bug')) errors.push('Unclassified issues require the approved label.');
      else {
        const body = issue.body || '';
        const choice = section(body, 'Assessment').toLowerCase();
        const small = choice === 'small' && rationale(body, 'Small blast radius');
        const understood = choice === 'understood' && rationale(body, 'Reproduction') && rationale(body, 'Impacts');
        if (!small && !understood) errors.push('Bug issues need a documented small blast radius or both reproduction and understood impacts, or the approved label.');
      }
    }
  }
  const count = files.filter(file => reviewable(file.filename || '') || (file.previous_filename && reviewable(file.previous_filename))).length;
  if (count > 15) errors.push(`${count} reviewable files exceed the limit of 15.`);
  return { errors, count };
}
