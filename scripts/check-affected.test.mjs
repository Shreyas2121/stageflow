import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkCommands, selectChecks } from './check-affected.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('web-only checks include its dependency prerequisite through package scripts', () => {
  const plan = selectChecks(['apps/web/src/App.tsx']);
  assert.deepEqual(plan, { full: false, packages: ['web'], audit: false });
  assert.deepEqual(
    checkCommands(plan).map((args) => args.join(' ')),
    [
      'format:check',
      '--filter @stageflow/web typecheck',
      '--filter @stageflow/web lint',
      '--filter @stageflow/web test',
      '--filter @stageflow/web build',
      'check:artifacts --web',
    ],
  );
});
test('API changes require Redis tests, compiled artifacts, and socket smoke', () => {
  const commands = checkCommands(selectChecks(['apps/api/src/live/scripts/leave.lua']));
  assert(commands.some((args) => args.join(' ') === '--filter @stageflow/api test'));
  assert.deepEqual(commands.at(-1), ['smoke:live']);
});
test('shared and unknown/root configuration changes select every consumer', () => {
  for (const path of [
    'packages/shared/src/stage.ts',
    'eslint.config.js',
    '.github/workflows/checks.yml',
    'scripts/dev.mjs',
    '.env.example',
  ]) {
    const plan = selectChecks([path]);
    assert.equal(plan.full, true, path);
    assert.deepEqual(checkCommands(plan), [['check:release']]);
  }
});
test('dependency changes require a full gate and audit', () => {
  for (const path of [
    'pnpm-lock.yaml',
    'package.json',
    'apps/web/package.json',
    'pnpm-workspace.yaml',
    'audit-exceptions.json',
  ]) {
    const plan = selectChecks([path]);
    assert.equal(plan.full, true, path);
    assert.equal(plan.audit, true, path);
  }
});
test('docs-only changes format without application work; full releases override selection', () => {
  assert.deepEqual(checkCommands(selectChecks(['README.md', 'plans/phase4.md'])), [
    ['format:check'],
  ]);
  assert.deepEqual(checkCommands(selectChecks([], true)), [['check:release']]);
  assert.deepEqual(selectChecks(['apps/web/src/removed.ts', 'apps/api/src/added.ts']).packages, [
    'api',
    'web',
  ]);
});

test('CLI uses the Git merge base and includes both sides of a renamed file', () => {
  const directory = mkdtempSync(join(tmpdir(), 'stageflow-check-selection-'));
  function git(...args) {
    const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  try {
    git('init', '-q');
    git('config', 'user.name', 'StageFlow check test');
    git('config', 'user.email', 'checks@example.invalid');
    mkdirSync(join(directory, 'apps/web/src'), { recursive: true });
    writeFileSync(join(directory, 'apps/web/src/moved.ts'), 'export const marker = 1;\n');
    git('add', '.');
    git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'base');
    const base = git('rev-parse', 'HEAD');
    mkdirSync(join(directory, 'apps/api/src'), { recursive: true });
    renameSync(join(directory, 'apps/web/src/moved.ts'), join(directory, 'apps/api/src/moved.ts'));
    git('add', '-A');
    git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'move');
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL('./check-affected.mjs', import.meta.url)), '--plan', '--base', base],
      { cwd: directory, encoding: 'utf8', windowsHide: true },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).packages, ['api', 'web']);
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert(directory.includes('stageflow-check-selection-'));
    rmSync(directory, { recursive: true, force: true });
  }
});
