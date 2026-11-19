// Pre-release Supabase migration policy guard. See docs/RELEASE.md ("Migration policy").
// Pure logic: no I/O. `files` is [{ status: 'A'|'M'|'D'|'R', path, previous? }] for origin/main...HEAD.
export const POLICY_FILE = 'supabase/migration-policy.json';
export const MODES = ['pre-release-open', 'pre-release-baseline', 'frozen'];
const MIGRATION = /^supabase\/migrations\/[^/]+$/;
const TIMESTAMPED = /^supabase\/migrations\/(\d{14})_[a-z0-9][a-z0-9_]*\.sql$/;
export const BASELINE_VERSION = /^\d{14}$/;
export const COMMIT_SHA = /^[a-f0-9]{40}$/;
const OVERRIDE = /^Migration-Policy-Override:[ \t]*(\S.*?)[ \t]*$/m;

export function parseOverride(text) {
  return typeof text === 'string' ? text.match(OVERRIDE)?.[1] ?? '' : '';
}

export function checkMigrationPolicy({ mode, files, override = '', baselineVersion = '' }) {
  const errors = [], warnings = [];
  if (!MODES.includes(mode)) return { errors: [`${POLICY_FILE}: mode must be one of ${MODES.join(', ')}.`], warnings };
  // A rename is a delete of the old path plus an add of the new one.
  const changes = files.flatMap(file => file.status === 'R'
    ? [{ status: 'D', path: file.previous }, { status: 'A', path: file.path }]
    : [{ status: file.status, path: file.path }]).filter(change => MIGRATION.test(change.path ?? ''));
  const added = changes.filter(change => change.status === 'A').map(change => change.path);
  const rewritten = changes.filter(change => change.status !== 'A').map(change => `${change.status} ${change.path}`);
  if (mode === 'pre-release-open' && added.length) {
    warnings.push(`New migration file(s) added while the squash is pending (${added.join(', ')}). They will be folded into the baseline.`);
  }
  if (mode === 'pre-release-baseline' && added.length && !override.trim()) {
    errors.push(`Pre-release baseline: do not add migration files (${added.join(', ')}); fold the change into the baseline. ` +
      'If a shared database already applied the baseline, add "Migration-Policy-Override: <reason>" to the PR body (or set MIGRATION_POLICY_OVERRIDE) and move the mode to frozen.');
  }
  if (mode === 'frozen' && rewritten.length) {
    errors.push(`Migrations are frozen (forward-only): applied history must not be modified, deleted or renamed (${rewritten.join(', ')}). Append a new migration instead.`);
  }
  if (mode === 'frozen') {
    // Forward-only: a new migration needs a timestamped name that sorts after the frozen baseline.
    const unnamed = added.filter(path => !TIMESTAMPED.test(path));
    if (unnamed.length) errors.push(`Frozen: new migrations must be named <14-digit timestamp>_<name>.sql (${unnamed.join(', ')}).`);
    const early = BASELINE_VERSION.test(baselineVersion)
      ? added.filter(path => TIMESTAMPED.test(path) && path.match(TIMESTAMPED)[1] <= baselineVersion) : [];
    if (early.length) errors.push(`Frozen: new migrations must have a timestamp after the baseline ${baselineVersion} (${early.join(', ')}).`);
  }
  return { errors, warnings };
}
