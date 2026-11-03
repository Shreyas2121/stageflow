import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { eslintArguments, lintFingerprints, lintTargetFromCwd, prepareLintCache } from './lint.mjs';

const targets = ['api', 'config', 'shared', 'web'];

async function write(root, path, content) {
  const file = join(root, path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content);
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'sf-lint-'));
  assert.ok(resolve(root).startsWith(resolve(tmpdir(), 'sf-lint-')));
  const files = {
    'eslint.config.js': 'export default [];\n',
    'tsconfig.base.json': '{}\n',
    'package.json': '{"name":"stageflow"}\n',
    'pnpm-lock.yaml': 'lockfileVersion: 9.0\n',
    'pnpm-workspace.yaml': 'packages:\n  - apps/*\n',
    'scripts/lint.mjs': '// lint\n',
    'scripts/dev.mjs': '// dev\n',
    'apps/api/package.json': '{"name":"@stageflow/api"}\n',
    'apps/api/tsconfig.json': '{}\n',
    'apps/api/src/main.ts': 'export const api = 1;\n',
    'apps/web/package.json': '{"name":"@stageflow/web"}\n',
    'apps/web/tsconfig.json': '{}\n',
    'apps/web/src/main.tsx': 'export const web = 1;\n',
    'packages/shared/package.json': '{"name":"@stageflow/shared"}\n',
    'packages/shared/tsconfig.json': '{}\n',
    'packages/shared/src/index.ts': 'export type Id = string;\n',
  };
  for (const [path, content] of Object.entries(files)) await write(root, path, content);
  t.after(async () => {
    assert.ok(resolve(root).startsWith(resolve(tmpdir(), 'sf-lint-')));
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

async function changedTargets(root, path, content) {
  const before = await lintFingerprints(root);
  await write(root, path, content);
  const after = await lintFingerprints(root);
  return targets.filter((target) => before[target] !== after[target]);
}

test('fingerprints follow typed dependencies and ignore unrelated edits', async (t) => {
  const root = await fixture(t);
  const first = await lintFingerprints(root);
  assert.deepEqual(await lintFingerprints(root), first);

  assert.deepEqual(await changedTargets(root, 'apps/web/src/main.tsx', 'export const web = 2;\n'), [
    'web',
  ]);
  assert.deepEqual(await changedTargets(root, 'apps/web/src/app.css', 'body {}\n'), []);
  assert.deepEqual(await changedTargets(root, 'apps/web/dist/index.js', 'console.log(1);\n'), []);
  assert.deepEqual(
    await changedTargets(root, 'apps/web/node_modules/pkg/index.js', 'module.exports = {};\n'),
    [],
  );
  assert.deepEqual(await changedTargets(root, 'apps/api/src/main.ts', 'export const api = 2;\n'), [
    'api',
  ]);
  assert.deepEqual(await changedTargets(root, 'apps/api/src/live.lua', '-- lua\n'), []);
  assert.deepEqual(
    await changedTargets(root, 'packages/shared/src/index.ts', 'export type Id = number;\n'),
    ['api', 'shared', 'web'],
  );
  assert.deepEqual(
    await changedTargets(
      root,
      'packages/shared/dist/index.d.ts',
      'export declare type Id = number;\n',
    ),
    ['api', 'web'],
  );
  assert.deepEqual(
    await changedTargets(
      root,
      'packages/shared/dist/index.d.ts',
      'export declare type Id = boolean;\n',
    ),
    ['api', 'web'],
  );
  assert.deepEqual(
    await changedTargets(root, 'packages/shared/dist/index.js', 'exports.unused = 1;\n'),
    [],
  );
  assert.deepEqual(
    await changedTargets(
      root,
      'packages/shared/package.json',
      '{"name":"@stageflow/shared","private":true}\n',
    ),
    ['api', 'shared', 'web'],
  );
  assert.deepEqual(
    await changedTargets(
      root,
      'apps/web/package.json',
      '{"name":"@stageflow/web","private":true}\n',
    ),
    ['web'],
  );
  assert.deepEqual(await changedTargets(root, 'eslint.config.js', 'export default [{}];\n'), [
    'api',
    'config',
    'shared',
    'web',
  ]);
  assert.deepEqual(await changedTargets(root, 'tsconfig.base.json', '{"compilerOptions":{}}\n'), [
    'api',
    'shared',
    'web',
  ]);
  assert.deepEqual(
    await changedTargets(root, 'pnpm-lock.yaml', 'lockfileVersion: 9.0\nchanged: true\n'),
    ['api', 'config', 'shared', 'web'],
  );
  assert.deepEqual(
    await changedTargets(root, 'pnpm-workspace.yaml', 'packages:\n  - packages/*\n'),
    ['api', 'config', 'shared', 'web'],
  );
  assert.deepEqual(await changedTargets(root, 'scripts/lint.mjs', '// changed lint\n'), [
    'api',
    'config',
    'shared',
    'web',
  ]);
  assert.deepEqual(await changedTargets(root, 'scripts/dev.mjs', '// changed dev\n'), ['config']);
  assert.deepEqual(await changedTargets(root, 'audit-exceptions.json', '{}\n'), []);
});

test('common inputs are read once and unrelated trees are not read', async (t) => {
  const root = await fixture(t);
  const counts = new Map();
  const io = {
    readFile: async (file) => {
      counts.set(file, (counts.get(file) ?? 0) + 1);
      return readFile(file);
    },
  };
  await lintFingerprints(root, ['api', 'web', 'shared', 'config'], io);
  for (const [file, count] of counts) assert.equal(count, 1, file);
  assert.equal(counts.get(join(root, 'packages/shared/src/index.ts')), 1);
  assert.equal(counts.get(join(root, 'scripts/lint.mjs')), 1);

  counts.clear();
  await lintFingerprints(root, ['api'], io);
  assert.equal(counts.has(join(root, 'apps/web/src/main.tsx')), false);
  assert.equal(counts.has(join(root, 'scripts/dev.mjs')), false);
  assert.equal(counts.get(join(root, 'packages/shared/src/index.ts')), 1);
  assert.equal(counts.get(join(root, 'eslint.config.js')), 1);
  assert.equal(counts.get(join(root, 'tsconfig.base.json')), 1);
  assert.equal(counts.get(join(root, 'pnpm-lock.yaml')), 1);
});

test('cache invalidation follows the package fingerprint', async (t) => {
  const root = await fixture(t);
  const cwd = join(root, 'apps/api');
  const cache = join(cwd, 'node_modules/.cache/eslint/content');
  const keyFile = join(cwd, 'node_modules/.cache/eslint/fingerprint');
  const prepared = await prepareLintCache({ root, cwd });
  assert.equal(prepared.target, 'api');
  assert.equal(prepared.invalidated, true);
  await writeFile(cache, 'cached');
  await writeFile(keyFile, prepared.key);

  await write(root, 'apps/web/src/main.tsx', 'export const web = 3;\n');
  const preserved = await prepareLintCache({ root, cwd });
  assert.equal(preserved.invalidated, false);
  assert.equal(preserved.key, prepared.key);
  assert.equal(await readFile(cache, 'utf8'), 'cached');

  await write(root, 'packages/shared/src/index.ts', 'export type Id = boolean;\n');
  const invalidated = await prepareLintCache({ root, cwd });
  assert.equal(invalidated.invalidated, true);
  assert.notEqual(invalidated.key, prepared.key);
  await assert.rejects(readFile(cache, 'utf8'));
  assert.equal(await readFile(keyFile, 'utf8'), prepared.key);
});

test('lint runs from a package directory or the workspace root', async (t) => {
  const root = await fixture(t);
  assert.equal(lintTargetFromCwd(root, root), 'config');
  assert.equal(lintTargetFromCwd(join(root, 'apps/api'), root), 'api');
  assert.equal(lintTargetFromCwd(join(root, 'apps/web'), root), 'web');
  assert.equal(lintTargetFromCwd(join(root, 'packages/shared'), root), 'shared');
  assert.throws(() => lintTargetFromCwd(join(root, 'apps/api/src'), root), /No lint cache scope/);
  await assert.rejects(lintFingerprints(root, ['missing']), /Unknown lint target/);
});

test('lint keeps the content cache and type-aware checks', async () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  assert.deepEqual(eslintArguments(root, ['src', 'vite.config.ts'], join(root, 'cache')), [
    join(root, 'node_modules/eslint/bin/eslint.js'),
    'src',
    'vite.config.ts',
    '--max-warnings',
    '0',
    '--cache',
    '--cache-strategy',
    'content',
    '--cache-location',
    join(root, 'cache'),
  ]);
  const config = await readFile(new URL('../eslint.config.js', import.meta.url), 'utf8');
  assert.match(config, /projectService:\s*true/);
  assert.match(config, /no-floating-promises/);
  assert.match(config, /no-misused-promises/);
});
