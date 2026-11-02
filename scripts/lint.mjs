import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const hash = createHash('sha256');

// ESLint's content cache alone cannot see changes in imported types. Invalidate
// each package cache on workspace source/config changes, including shared types.
async function fingerprint(directory, recursive = true) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (['node_modules', 'dist', 'coverage', '.git'].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (recursive) await fingerprint(path);
    } else if (/\.(?:ts|tsx|js|mjs|json)$/.test(entry.name) || entry.name === 'pnpm-lock.yaml') {
      hash.update(path).update(await readFile(path));
    }
  }
}

await fingerprint(root, false);
await fingerprint(join(root, 'scripts'));
for (const directory of ['apps/api', 'apps/web', 'packages/shared']) {
  await fingerprint(join(root, directory), false);
  await fingerprint(join(root, directory, 'src'));
}
const key = hash.digest('hex');
const cacheDirectory = join(process.cwd(), 'node_modules/.cache/eslint');
const cacheFile = join(cacheDirectory, 'content');
const keyFile = join(cacheDirectory, 'fingerprint');
await mkdir(cacheDirectory, { recursive: true });
const previousKey = await readFile(keyFile, 'utf8').catch((error) => {
  if (error.code !== 'ENOENT') throw error;
  return null;
});
if (key !== previousKey) await rm(cacheFile, { force: true });
const result = spawnSync(
  process.execPath,
  [
    join(root, 'node_modules/eslint/bin/eslint.js'),
    ...process.argv.slice(2),
    '--max-warnings',
    '0',
    '--cache',
    '--cache-strategy',
    'content',
    '--cache-location',
    cacheFile,
  ],
  { stdio: 'inherit', windowsHide: true },
);
if (result.error) throw result.error;
if (result.status === 0) await writeFile(keyFile, key);
process.exit(result.status ?? 1);
