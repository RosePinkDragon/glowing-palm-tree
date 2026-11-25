// Pre-release Supabase migration policy guard. See docs/RELEASE.md ("Migration policy").
// Pure logic: no I/O. `files` is [{ status: 'A'|'M'|'D'|'R', path, previous? }] for origin/main...HEAD.
export const POLICY_FILE = 'supabase/migration-policy.json';
export const MODES = ['pre-release-open', 'pre-release-baseline', 'frozen'];
const MIGRATION = /^supabase\/migrations\/[\s\S]+$/i;
const CANONICAL_PREFIX = /^supabase\/migrations\//;
const NESTED = /^supabase\/migrations\/[\s\S]*\//i;
const TIMESTAMPED = /^supabase\/migrations\/(\d{14})_[a-z0-9][a-z0-9_]*\.sql$/;
const timestampMatch = path => path.replace(/^supabase\/migrations\//i, 'supabase/migrations/').match(TIMESTAMPED);
const validTimestamp = value => {
  const iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(8, 10)}:${value.slice(10, 12)}:${value.slice(12, 14)}.000Z`;
  const date = new Date(iso);
  return !Number.isNaN(date.getTime()) && date.toISOString() === iso;
};
export const BASELINE_VERSION = /^\d{14}$/;
export const COMMIT_SHA = /^[a-f0-9]{40}$/;
const OVERRIDE = /^Migration-Policy-Override:[ \t]*(\S.*?)[ \t]*$/m;

export function parseOverride(text) {
  return typeof text === 'string' ? text.match(OVERRIDE)?.[1] ?? '' : '';
}

export function checkMigrationPolicy({ mode, files, override = '', baselineVersion = '', now = new Date() }) {
  const errors = [], warnings = [];
  if (!MODES.includes(mode)) return { errors: [`${POLICY_FILE}: mode must be one of ${MODES.join(', ')}.`], warnings };
  if (files.some(file => [file.path, file.previous].some(path => typeof path === 'string' && path.toLowerCase() === POLICY_FILE))) {
    warnings.push(`${POLICY_FILE} changes require explicit owner approval.`);
  }
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
    if (typeof baselineVersion !== 'string' || !BASELINE_VERSION.test(baselineVersion)) {
      errors.push('Frozen: baseline version must be a 14-digit timestamp.');
    }
    const wrongCase = added.filter(path => !CANONICAL_PREFIX.test(path));
    if (wrongCase.length) errors.push(`Frozen: migration paths must use the exact lowercase supabase/migrations/ prefix (${wrongCase.join(', ')}).`);
    const nested = changes.filter(change => NESTED.test(change.path)).map(change => change.path);
    if (nested.length) errors.push(`Frozen: nested migration paths are not allowed (${nested.join(', ')}).`);
    // Forward-only: a new migration needs a timestamped name that sorts after the frozen baseline.
    const unnamed = added.filter(path => !NESTED.test(path) && !timestampMatch(path));
    if (unnamed.length) errors.push(`Frozen: new migrations must be named <14-digit timestamp>_<name>.sql (${unnamed.join(', ')}).`);
    const invalidDates = added.filter(path => timestampMatch(path) && !validTimestamp(timestampMatch(path)[1]));
    if (invalidDates.length) errors.push(`Frozen: migration timestamps must be valid UTC calendar dates (${invalidDates.join(', ')}).`);
    const early = typeof baselineVersion === 'string' && BASELINE_VERSION.test(baselineVersion)
      ? added.filter(path => timestampMatch(path) && timestampMatch(path)[1] <= baselineVersion) : [];
    const futureLimit = new Date(now);
    futureLimit.setUTCFullYear(futureLimit.getUTCFullYear() + 1);
    const maxTimestamp = futureLimit.toISOString().slice(0, 19).replace(/[-:T]/g, '');
    const future = added.filter(path => timestampMatch(path)?.[1] > maxTimestamp);
    if (future.length) errors.push(`Frozen: migration timestamps must be no more than one year in the future (${future.join(', ')}).`);
    if (early.length) errors.push(`Frozen: new migrations must have a timestamp after the baseline ${baselineVersion} (${early.join(', ')}).`);
  }
  return { errors, warnings };
}
