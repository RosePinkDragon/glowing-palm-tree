import { POLICY_FILE, MODES, BASELINE_VERSION, COMMIT_SHA, checkMigrationPolicy, parseOverride } from './migration-policy.mjs';

// All reads go through the runner's authenticated, same-origin API client.
// Resolve main first, then pin the contents request to that commit. Neither a
// retained PR base SHA nor a file/configuration from the PR supplies the rule.
export async function readMainMigrationPolicy({ repository, request }) {
  const { data: ref } = await request(`/repos/${repository}/git/ref/heads/main`);
  const sha = ref?.object?.sha;
  if (ref?.object?.type !== 'commit' || typeof sha !== 'string' || !/^[a-f0-9]{40}$/i.test(sha)) throw new Error('Could not verify the main commit for migration policy.');
  let file;
  try { ({ data: file } = await request(`/repos/${repository}/contents/${POLICY_FILE}?ref=${sha}`)); }
  catch (err) {
    // Match local preflight's bootstrap behavior: absent on main, not absent on
    // the PR. Missing/inaccessible main itself is never a bootstrap exception.
    if (err.status === 404) return null;
    throw err;
  }
  if (file?.type !== 'file' || file.path !== POLICY_FILE || file.encoding !== 'base64' || typeof file.content !== 'string' || file.truncated) throw new Error('Migration policy on main is incomplete or unreadable.');
  const encoded = file.content.replace(/\r?\n/g, '');
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new Error('Migration policy on main has invalid encoding.');
  let policy;
  try { policy = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')); }
  catch { throw new Error('Migration policy on main is invalid JSON.'); }
  if (!policy || typeof policy !== 'object' || Array.isArray(policy) || !MODES.includes(policy.mode)) throw new Error('Migration policy on main has an invalid mode.');
  return policy;
}

export function migrationChanges(files) {
  const statuses = { added: 'A', copied: 'A', modified: 'M', changed: 'M', removed: 'D', renamed: 'R', unchanged: null };
  return files.flatMap(file => {
    if (typeof file.filename !== 'string' || !file.filename || !Object.hasOwn(statuses, file.status) ||
        (file.status === 'renamed' && (typeof file.previous_filename !== 'string' || !file.previous_filename))) throw new Error('File metadata is incomplete for migration policy.');
    // An unchanged file contributes no migration operation. The separate
    // reviewable-file count remains untouched and does not gain an exemption.
    if (file.status === 'unchanged') return [];
    return [{ status: statuses[file.status], path: file.filename, ...(file.status === 'renamed' ? { previous: file.previous_filename } : {}) }];
  });
}

// Frozen-mode existence checks. They run through the same API client as the policy
// read, against the PR head sha, so no checkout (or checkout depth) is involved and
// the PR's own copy of the policy is never consulted. Anything unverifiable is an
// error or a thrown failure, never a pass.
export async function checkBaselineExists({ repository, request, baseline, headSha }) {
  const errors = [];
  if (!baseline || typeof baseline !== 'object' || !BASELINE_VERSION.test(baseline.version) || !COMMIT_SHA.test(baseline.commit)) {
    return ['Frozen: baseline on main must record a 14-digit version and a 40-character lowercase commit.'];
  }
  if (typeof headSha !== 'string' || !/^[a-f0-9]{40}$/i.test(headSha)) throw new Error('Could not verify the PR head commit for migration policy.');
  let listing = null;
  try { ({ data: listing } = await request(`/repos/${repository}/contents/supabase/migrations?ref=${headSha}`)); }
  catch (err) { if (err.status !== 404) throw err; }
  if (listing !== null) {
    // The directory listing is capped at 1000 entries; a capped listing cannot prove absence.
    if (!Array.isArray(listing) || listing.length >= 1000) throw new Error('Migration directory listing is incomplete or capped.');
    const prefix = `${baseline.version}_`;
    if (!listing.some(entry => entry?.type === 'file' && entry.name.startsWith(prefix) && entry.name.endsWith('.sql'))) listing = null;
  }
  if (listing === null) errors.push(`Frozen: baseline migration supabase/migrations/${baseline.version}_*.sql does not exist in this PR's tree.`);
  try {
    const { data: compare } = await request(`/repos/${repository}/compare/${baseline.commit}...${headSha}?per_page=1`);
    // "ahead" or "identical": baseline.commit is an ancestor of (or equal to) the head.
    if (!['ahead', 'identical'].includes(compare?.status)) {
      if (!['behind', 'diverged'].includes(compare?.status)) throw new Error('Could not verify baseline commit ancestry.');
      errors.push(`Frozen: baseline commit ${baseline.commit} is not an ancestor of this PR's head.`);
    }
  } catch (err) {
    if (err.status !== 404 && err.status !== 422) throw err;
    errors.push(`Frozen: baseline commit ${baseline.commit} does not exist in this repository.`);
  }
  return errors;
}

export async function evaluateTrustedMigrations({ repository, request, files, body, headSha }) {
  const policy = await readMainMigrationPolicy({ repository, request });
  if (policy === null) return { errors: [], warnings: [] };
  const changes = migrationChanges(files);
  const verdict = checkMigrationPolicy({ mode: policy.mode, files: changes, override: parseOverride(body), baselineVersion: policy.baseline?.version });
  if (changes.some(file => (file.path === POLICY_FILE && file.status === 'D') ||
      (file.previous === POLICY_FILE && file.path !== POLICY_FILE))) verdict.errors.push(`${POLICY_FILE} must remain present; restore it before merging.`);
  if (policy.mode === 'frozen') verdict.errors.push(...await checkBaselineExists({ repository, request, baseline: policy.baseline, headSha }));
  return verdict;
}
