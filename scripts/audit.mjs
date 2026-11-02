import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

export function checkAudit(
  report,
  exceptions,
  production = false,
  today = new Date().toISOString().slice(0, 10),
) {
  assert(
    report && report.advisories && report.metadata?.vulnerabilities,
    'Malformed audit report or registry error.',
  );
  const advisories = Object.values(report.advisories);
  const count = Object.values(report.metadata.vulnerabilities).reduce(
    (sum, value) => sum + value,
    0,
  );
  assert.equal(count, advisories.length, 'Audit counts do not match advisory records.');
  for (const exception of exceptions) {
    assert(
      exception.owner && exception.reason && /^\d{4}-\d{2}-\d{2}$/.test(exception.reviewBy),
      'Incomplete audit exception.',
    );
    assert(
      exception.reviewBy >= today,
      `Audit exception ${exception.id} needs maintainer review (${exception.reviewBy}).`,
    );
  }
  for (const advisory of advisories) {
    const id = advisory.github_advisory_id ?? advisory.url?.split('/').at(-1);
    const exception = exceptions.find(
      (item) =>
        item.id === id &&
        item.module === advisory.module_name &&
        item.severity === advisory.severity,
    );
    assert(
      !production && exception,
      `Unaccepted ${advisory.severity} advisory: ${id} (${advisory.module_name}).`,
    );
    console.log(
      `Temporary dev exception: ${id}, ${advisory.module_name}; review by ${exception.reviewBy}.`,
    );
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const exceptions = JSON.parse(
    await readFile(new URL('../audit-exceptions.json', import.meta.url), 'utf8'),
  );
  for (const production of [true, false]) {
    // pnpm exits 1 for advisories; only successful, parseable reports may be evaluated.
    const result = spawnSync('pnpm', ['audit', ...(production ? ['--prod'] : []), '--json'], {
      encoding: 'utf8',
      shell: process.platform === 'win32',
      windowsHide: true,
    });
    if (result.error) throw result.error;
    assert([0, 1].includes(result.status), `Audit command failed: ${result.stderr}`);
    const report = JSON.parse(result.stdout);
    if (result.status === 1)
      assert(
        Object.keys(report.advisories ?? {}).length,
        'Audit failed without reporting advisories.',
      );
    checkAudit(report, production ? [] : exceptions, production);
  }
  console.log(
    'Audit gate passed: production has no advisories; only explicit unexpired dev exceptions remain.',
  );
}
