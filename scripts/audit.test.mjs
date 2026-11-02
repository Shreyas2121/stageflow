import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkAudit } from './audit.mjs';

const exception = {
  id: 'GHSA-test',
  module: 'tool',
  severity: 'low',
  owner: 'maintainer',
  reason: 'Local tooling only.',
  reviewBy: '2026-11-08',
};
const advisory = { github_advisory_id: exception.id, module_name: 'tool', severity: 'low' };
const report = (items) => ({
  advisories: Object.fromEntries(items.map((item, i) => [i, item])),
  metadata: { vulnerabilities: { low: items.length } },
});
test('audit accepts only the named, unexpired development exception', () => {
  checkAudit(report([advisory]), [exception], false, '2026-11-02');
  assert.throws(
    () => checkAudit(report([advisory]), [exception], true, '2026-11-02'),
    /Unaccepted/,
  );
  assert.throws(
    () => checkAudit(report([advisory]), [exception], false, '2026-11-09'),
    /needs maintainer review/,
  );
  for (const replacement of [
    { github_advisory_id: 'new' },
    { module_name: 'other' },
    { severity: 'critical' },
  ]) {
    assert.throws(
      () => checkAudit(report([{ ...advisory, ...replacement }]), [exception], false, '2026-11-02'),
      /Unaccepted/,
    );
  }
});
test('audit fails closed on malformed reports, incomplete counts, and incomplete exceptions', () => {
  assert.throws(() => checkAudit({ error: 'registry unreachable' }, []), /Malformed/);
  assert.throws(
    () => checkAudit({ advisories: {}, metadata: { vulnerabilities: { high: 1 } } }, []),
    /counts/,
  );
  assert.throws(() => checkAudit(report([]), [{ ...exception, owner: '' }]), /Incomplete/);
  checkAudit(report([]), [], true);
});
