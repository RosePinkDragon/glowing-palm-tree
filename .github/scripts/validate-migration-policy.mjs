import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { MODES, POLICY_FILE } from './migration-policy.mjs';

// App CI validates the proposed checkout as data. This does not supply the
// effective rule to the privileged Delivery policy runner, which reads main.
export function validateMigrationPolicyFile(file = new URL('../../supabase/migration-policy.json', import.meta.url)) {
  let policy;
  try { policy = JSON.parse(readFileSync(file, 'utf8')); }
  catch { throw new Error(`${POLICY_FILE} must contain readable, valid JSON.`); }
  if (!policy || typeof policy !== 'object' || Array.isArray(policy) || !MODES.includes(policy.mode)) {
    throw new Error(`${POLICY_FILE} must be a JSON object with a known mode: ${MODES.join(', ')}.`);
  }
  return policy;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { validateMigrationPolicyFile(process.argv[2]); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
