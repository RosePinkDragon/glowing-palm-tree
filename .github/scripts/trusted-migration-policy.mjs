import { POLICY_FILE, MODES, checkMigrationPolicy, parseOverride } from './migration-policy.mjs';

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

export async function evaluateTrustedMigrations({ repository, request, files, body }) {
  const policy = await readMainMigrationPolicy({ repository, request });
  if (policy === null) return { errors: [], warnings: [] };
  const changes = migrationChanges(files);
  const verdict = checkMigrationPolicy({ mode: policy.mode, files: changes, override: parseOverride(body) });
  if (changes.some(file => (file.path === POLICY_FILE && file.status === 'D') ||
      (file.previous === POLICY_FILE && file.path !== POLICY_FILE))) verdict.errors.push(`${POLICY_FILE} must remain present; restore it before merging.`);
  return verdict;
}
