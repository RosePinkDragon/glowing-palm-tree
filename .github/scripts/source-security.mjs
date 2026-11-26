import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const policy = fileURLToPath(new URL('../security/', import.meta.url));
const allowlist = fileURLToPath(new URL('../../.gitleaksignore', import.meta.url));
const sha = /^[0-9a-f]{40}$/;
class ScanError extends Error {}

function hasCommit(value = '') {
  return sha.test(value) &&
    spawnSync('git', ['cat-file', '-e', `${value}^{commit}`], { stdio: 'ignore' }).status === 0;
}

function secretScan() {
  const { GITHUB_EVENT_NAME: event, SCAN_HEAD: head, SCAN_BASE: base } = process.env;
  let revision;
  if (event === 'workflow_dispatch') {
    revision = '--all HEAD';
  } else if (event === 'pull_request' || event === 'push') {
    if (!hasCommit(head)) throw new ScanError('Secret scan could not find the event head commit.');
    if (hasCommit(base)) revision = `${base}..${head}`;
    else if (event === 'push') revision = head;
    else throw new ScanError('Secret scan could not find the PR base commit.');
  } else {
    throw new ScanError('Unknown event for secret scan.');
  }

  // Never forward scanner output or create an artifact. A filename or diagnostic can itself contain a secret.
  const scan = spawnSync('gitleaks', [
    'git', '--no-banner', '--redact=100', '--exit-code=3', '--ignore-gitleaks-allow',
    '--config', `${policy}gitleaks.toml`, '--gitleaks-ignore-path', allowlist,
    `--log-opts=${revision} --diff-merges=first-parent`, '.',
  ], { stdio: 'ignore', timeout: 180_000 });
  if (scan.status === 3) throw new ScanError('Secret scan detected potential credentials. See docs/source-security.md for private triage.');
  if (scan.status !== 0) throw new ScanError('Secret scanner did not complete. Check the pinned tool and Git history.');
  console.log('Secret scan passed.');
}

function staticAnalysis() {
  const scan = spawnSync('semgrep', [
    'scan', '--oss-only', '--strict', '--metrics=off', '--disable-version-check', '--no-rewrite-rule-ids', '--disable-nosem',
    // Semgrep 1.187.0 cannot parse this valid script. Node's policy tests still cover it.
    '--exclude=/.github/scripts/delivery-policy.mjs',
    '--config', `${policy}semgrep.yml`, '--json', '.github/scripts', 'packages/services', 'supabase/functions',
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 180_000, maxBuffer: 16 * 1024 * 1024 });
  if (scan.status !== 0) throw new ScanError('Static analysis did not complete. Check the pinned tool, rules and targets.');
  let report;
  try { report = JSON.parse(scan.stdout); }
  catch { throw new ScanError('Static analysis did not return valid JSON.'); }
  if (!Array.isArray(report?.errors) || report.errors.length || !Array.isArray(report.results) ||
      !Array.isArray(report.paths?.scanned) || report.paths.scanned.length === 0) {
    throw new ScanError('Static analysis returned an incomplete scan.');
  }

  const blocking = report.results.filter(finding => finding.extra?.severity === 'ERROR').length;
  console.log(`Static analysis scanned ${report.paths.scanned.length} files with ${blocking} blocking and ${report.results.length - blocking} report-only findings.`);
  if (blocking) throw new ScanError('Static analysis found blocking patterns. See docs/source-security.md for the rule list.');
}

try {
  const mode = process.argv[2];
  if (mode === 'secrets') secretScan();
  else if (mode === 'static') staticAnalysis();
  else throw new ScanError('Use source-security.mjs secrets or static.');
} catch (error) {
  // Do not forward unexpected tool or parsing errors, which may contain source.
  console.error(error instanceof ScanError ? error.message : 'Source security check failed.');
  process.exitCode = 1;
}
