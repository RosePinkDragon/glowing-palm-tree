import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rank = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };
const ghsa = /^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/;
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function evaluateAudit(report, packages, allowlist, today) {
  if (report?.auditReportVersion !== 2 || report.error || !isRecord(report.vulnerabilities)) {
    throw new Error('npm audit did not return a usable v2 advisory report.');
  }
  if (!Array.isArray(allowlist)) throw new Error('The audit allowlist must be an array.');

  const exceptions = new Map();
  for (const entry of allowlist) {
    const { advisory, path, version, expires, reason } = entry ?? {};
    if (!ghsa.test(advisory) || typeof path !== 'string' || !path.startsWith('node_modules/') ||
        typeof version !== 'string' || !version || typeof reason !== 'string' || !reason.trim() ||
        typeof expires !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(expires) ||
        !Number.isFinite(Date.parse(expires)) || new Date(expires).toISOString().slice(0, 10) !== expires) {
      throw new Error('Invalid audit exception. Supply advisory, path, version, expires and reason.');
    }
    const key = JSON.stringify([advisory, path, version]);
    if (exceptions.has(key)) throw new Error(`Duplicate audit exception for ${advisory} at ${path}.`);
    exceptions.set(key, entry);
  }

  const findings = [];
  const direct = new Set();
  const dependencies = new Map();
  for (const [name, row] of Object.entries(report.vulnerabilities)) {
    if (!Object.hasOwn(rank, row?.severity) || !Array.isArray(row.via) || !row.via.length ||
        !Array.isArray(row.nodes) || !row.nodes.length) {
      throw new Error('npm audit returned a malformed affected-package entry.');
    }
    const inherited = [];
    dependencies.set(name, inherited);
    for (const item of row.via) {
      if (typeof item === 'string') {
        inherited.push(item);
        continue;
      }
      if (!Object.hasOwn(rank, item?.severity) || !Number.isInteger(item.source)) {
        throw new Error('npm audit returned a malformed advisory.');
      }
      direct.add(name);
      const candidate = typeof item.url === 'string' && item.url.startsWith('https://github.com/advisories/')
        ? item.url.slice('https://github.com/advisories/'.length) : '';
      const advisory = ghsa.test(candidate) ? candidate : `npm advisory ${item.source}`;
      for (const path of row.nodes) {
        const version = typeof path === 'string' && Object.hasOwn(packages, path) && packages[path]?.version;
        if (typeof version !== 'string' || !version) throw new Error(`Audit finding for ${advisory} has no pinned version in the lockfile.`);
        const exception = exceptions.get(JSON.stringify([advisory, path, version]));
        const blocking = rank[item.severity] >= rank.high;
        const accepted = item.severity === 'high' && exception && today < exception.expires;
        findings.push({ advisory, path, version, severity: item.severity, blocking: blocking && !accepted,
          status: accepted ? `accepted until ${exception.expires}` : blocking ? exception && today >= exception.expires ? 'blocked (exception expired)' : 'blocked' : 'reported' });
      }
    }
  }
  // An npm metavulnerability should trace to a concrete advisory. A broken report must not pass.
  const traced = new Set(direct);
  for (;;) {
    const previous = traced.size;
    for (const [name, via] of dependencies) if (via.some(child => traced.has(child))) traced.add(name);
    if (traced.size === previous) break;
  }
  if (traced.size !== dependencies.size || [...dependencies.values()].some(via => via.some(child => !dependencies.has(child)))) {
    throw new Error('npm audit returned an unresolved dependency advisory.');
  }
  return findings;
}

function main() {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const readJson = path => JSON.parse(readFileSync(resolve(root, path), 'utf8'));
  const { packages } = readJson('package-lock.json');
  if (!isRecord(packages)) throw new Error('package-lock.json must list pinned packages.');
  const allowlist = readJson('docs/policy/npm-audit-allowlist.json');
  // npm exits 1 when it finds advisories. The policy below decides which of them block.
  const args = ['audit', '--package-lock-only', '--json', '--audit-level=low', '--include=dev', '--include=optional', '--include=peer'];
  const result = spawnSync('npm', args, {
    cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 120_000,
  });
  if (result.error || ![0, 1].includes(result.status)) throw new Error('npm audit could not complete. Check npm registry availability and retry.');
  let report;
  try { report = JSON.parse(result.stdout); }
  catch { throw new Error('npm audit did not return JSON. Check npm registry availability and retry.'); }
  const findings = evaluateAudit(report, packages, allowlist, new Date().toISOString().slice(0, 10));
  if (result.status === 1 && findings.length === 0) throw new Error('npm audit failed without reporting any advisories.');
  for (const entry of findings) console.log(`${entry.severity} ${entry.advisory} ${entry.path}@${entry.version}: ${entry.status}`);
  const blocked = findings.filter(entry => entry.blocking);
  console.log(`Dependency audit: ${findings.length} advisory occurrences, ${blocked.length} blocking.`);
  if (blocked.length) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); }
  catch (error) {
    console.error(`Dependency audit: ${error.message}`);
    process.exitCode = 1;
  }
}
