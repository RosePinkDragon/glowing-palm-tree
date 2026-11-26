import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateAudit } from './dependency-audit.mjs';

const path = 'node_modules/transitive';
const advisory = 'GHSA-abcd-1234-efgh';
const packages = { [path]: { version: '1.2.3' } };
const exception = { advisory, path, version: '1.2.3', expires: '2026-12-26', reason: 'Reviewed fixture' };
const report = (severity = 'high') => ({
  auditReportVersion: 2,
  vulnerabilities: {
    transitive: { severity, nodes: [path], via: [{ source: 123, url: `https://github.com/advisories/${advisory}`, severity }] },
    parent: { severity, nodes: ['node_modules/parent'], via: ['transitive'] },
  },
});
const blocked = (audit, allowlist = [], today = '2026-12-25') =>
  evaluateAudit(audit, packages, allowlist, today).filter(finding => finding.blocking);

test('high and critical block, moderate is reported, and transitive parents are not counted twice', () => {
  assert.equal(blocked(report()).length, 1);
  assert.equal(blocked(report('critical'), [exception]).length, 1);
  const findings = evaluateAudit(report('moderate'), packages, [], '2026-12-25');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].status, 'reported');
});

test('a high exception needs the exact advisory, path and version and stops at UTC expiry', () => {
  assert.equal(blocked(report(), [exception]).length, 0);
  for (const changed of [{ advisory: 'GHSA-abcd-1234-0000' }, { path: 'node_modules/other' }, { version: '1.2.4' }]) {
    assert.equal(blocked(report(), [{ ...exception, ...changed }]).length, 1);
  }
  assert.match(blocked(report(), [exception], '2026-12-26')[0].status, /expired/);
});

test('invalid exceptions, registry errors and untraceable advisories fail closed', () => {
  assert.throws(() => blocked(report(), [{ ...exception, expires: '2026-02-30' }]), /Invalid audit exception/);
  assert.throws(() => blocked(report(), [exception, exception]), /Duplicate audit exception/);
  assert.throws(() => blocked({ error: { code: 'E503' } }), /usable v2 advisory report/);
  const malformed = report();
  delete malformed.vulnerabilities.transitive;
  assert.throws(() => blocked(malformed), /unresolved dependency advisory/);
});
