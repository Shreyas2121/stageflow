import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const workspace = fileURLToPath(new URL('../', import.meta.url));
const SKIP = new Set(['node_modules', 'dist', 'coverage', '.git']);
const SOURCE_FILE = /\.(?:ts|tsx|js|mjs|json)$/;
const ESLINT_FILES = [
  'eslint.config.js',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'scripts/lint.mjs',
];

// ESLint's content cache hashes the linted file only. Type-aware rules also see
// imported types, so each cache is keyed by that package's closure. API and web
// include shared source and the declarations TypeScript resolves; shared does
// not include either app. Root script lint includes config and scripts.
export const LINT_SCOPE = {
  api: ['eslint', 'typescript', 'apps/api', 'packages/shared', 'packages/shared/dist'],
  web: ['eslint', 'typescript', 'apps/web', 'packages/shared', 'packages/shared/dist'],
  shared: ['eslint', 'typescript', 'packages/shared'],
  config: ['eslint', 'scripts'],
};

const comparePath = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const relativePosix = (root, file) => relative(root, file).split(sep).join('/');

export function lintTargetFromCwd(cwd, root) {
  const rel = relativePosix(resolve(root), resolve(cwd));
  if (rel === '') return 'config';
  const target = { 'apps/api': 'api', 'apps/web': 'web', 'packages/shared': 'shared' }[rel];
  if (!target) throw new Error(`No lint cache scope for working directory ${rel}.`);
  return target;
}

async function collectFiles(root, directory, recursive, predicate) {
  const files = [];
  async function walk(current, recurse) {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      throw new Error(`Lint fingerprint input is missing: ${relativePosix(root, current)}`, {
        cause: error,
      });
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink() || SKIP.has(entry.name)) continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        if (recurse) await walk(path, true);
      } else if (entry.isFile() && predicate(entry.name)) files.push(path);
    }
  }
  await walk(directory, recursive);
  return files;
}

async function requiredFiles(root, paths) {
  const files = [];
  for (const path of paths) {
    try {
      const info = await lstat(join(root, path));
      if (!info.isFile()) throw new Error(`Lint fingerprint input is not a file: ${path}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      throw new Error(`Lint fingerprint input is missing: ${path}`, { cause: error });
    }
    files.push(join(root, path));
  }
  return files;
}

async function listGroup(root, group) {
  if (group === 'eslint') return { files: await requiredFiles(root, ESLINT_FILES) };
  if (group === 'typescript') return { files: await requiredFiles(root, ['tsconfig.base.json']) };
  if (group === 'scripts')
    return {
      files: await collectFiles(root, join(root, 'scripts'), true, (name) =>
        SOURCE_FILE.test(name),
      ),
    };
  if (group === 'apps/api' || group === 'apps/web' || group === 'packages/shared') {
    const directory = join(root, group);
    return {
      files: [
        ...(await collectFiles(root, directory, false, (name) => SOURCE_FILE.test(name))),
        ...(await collectFiles(root, join(directory, 'src'), true, (name) =>
          SOURCE_FILE.test(name),
        )),
      ],
    };
  }
  if (group === 'packages/shared/dist') {
    const directory = join(root, group);
    try {
      const info = await lstat(directory);
      if (!info.isDirectory()) return { files: [], presence: 'packages/shared/dist missing' };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return { files: [], presence: 'packages/shared/dist missing' };
    }
    return {
      files: await collectFiles(root, directory, true, (name) => name.endsWith('.d.ts')),
      presence: 'packages/shared/dist present',
    };
  }
  throw new Error(`Unknown lint input group: ${group}`);
}

export async function lintFingerprints(root, targets = Object.keys(LINT_SCOPE), io = { readFile }) {
  root = resolve(root);
  const unknown = targets.filter((target) => !LINT_SCOPE[target]);
  if (unknown.length) throw new Error(`Unknown lint target: ${unknown.join(', ')}`);
  const groups = [...new Set(targets.flatMap((target) => LINT_SCOPE[target]))];
  const listed = new Map();
  for (const group of groups) listed.set(group, await listGroup(root, group));
  const contents = new Map();
  for (const group of groups) {
    for (const file of listed.get(group).files) {
      if (contents.has(file)) continue;
      contents.set(file, await io.readFile(file));
    }
  }
  const groupHashes = new Map();
  for (const group of groups) {
    const hash = createHash('sha256');
    const { files, presence } = listed.get(group);
    if (presence) hash.update(presence).update('\0');
    for (const file of [...files].sort(comparePath)) {
      hash.update(relativePosix(root, file)).update('\0').update(contents.get(file)).update('\0');
    }
    groupHashes.set(group, hash.digest());
  }
  const fingerprints = {};
  for (const target of targets) {
    const hash = createHash('sha256').update(target).update('\0');
    for (const group of LINT_SCOPE[target])
      hash.update(group).update('\0').update(groupHashes.get(group));
    fingerprints[target] = hash.digest('hex');
  }
  return fingerprints;
}

export function eslintArguments(root, userArgs, cacheFile) {
  return [
    join(root, 'node_modules/eslint/bin/eslint.js'),
    ...userArgs,
    '--max-warnings',
    '0',
    '--cache',
    '--cache-strategy',
    'content',
    '--cache-location',
    cacheFile,
  ];
}

export async function prepareLintCache({ root, cwd }) {
  const target = lintTargetFromCwd(cwd, root);
  const key = (await lintFingerprints(root, [target]))[target];
  const directory = join(cwd, 'node_modules/.cache/eslint');
  const cacheFile = join(directory, 'content');
  const keyFile = join(directory, 'fingerprint');
  await mkdir(directory, { recursive: true });
  const previousKey = await readFile(keyFile, 'utf8').catch((error) => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  const invalidated = key !== previousKey;
  if (invalidated) await rm(cacheFile, { force: true });
  return { target, key, cacheFile, keyFile, invalidated };
}

async function main() {
  const prepared = await prepareLintCache({ root: workspace, cwd: process.cwd() });
  const result = spawnSync(
    process.execPath,
    eslintArguments(workspace, process.argv.slice(2), prepared.cacheFile),
    { stdio: 'inherit', windowsHide: true },
  );
  if (result.error) throw result.error;
  if (result.status === 0) await writeFile(prepared.keyFile, prepared.key);
  process.exit(result.status ?? 1);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
