import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  freeSpaceBytes,
  measureFreeBytes,
  measureStoredBytes,
  StorageScanError,
} from './storage-budget';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'sf-budget-secret-'));
  roots.push(path);
  return path;
}

it('sums regular files and treats a missing directory as empty', async () => {
  const root = await directory();
  expect(await measureStoredBytes(join(root, 'missing'))).toBe(0);
  await mkdir(join(root, 'broadcasts', 'one'), { recursive: true });
  await writeFile(join(root, 'broadcasts', 'one', 'index.m3u8'), 'abc');
  await writeFile(join(root, 'broadcasts', 'one', 'segment.ts'), 'defg');
  expect(await measureStoredBytes(join(root, 'broadcasts'))).toBe(7);
  expect(await readFile(join(root, 'broadcasts', 'one', 'index.m3u8'), 'utf8')).toBe('abc');
});

it('refuses a walk past the entry cap without revealing the path', async () => {
  const root = await directory();
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'a.ts'), 'a');
  await writeFile(join(root, 'b.ts'), 'b');
  await writeFile(join(root, 'c.ts'), 'c');
  const error = await measureStoredBytes(root, { entries: 2, depth: 3 }).catch(
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(StorageScanError);
  expect(error).toMatchObject({ message: 'Recording storage could not be measured.' });
  expect(String(error)).not.toContain('sf-budget-secret');
  expect(await readFile(join(root, 'c.ts'), 'utf8')).toBe('c');
});

it('counts a file at the depth limit and refuses a deeper directory', async () => {
  const root = await directory();
  const file = join(root, 'a', 'b', 'c', 'leaf.txt');
  await mkdir(join(root, 'a', 'b', 'c'), { recursive: true });
  await writeFile(file, 'leaf');
  expect(await measureStoredBytes(root, { entries: 100, depth: 3 })).toBe(4);
  await mkdir(join(root, 'a', 'b', 'c', 'd'), { recursive: true });
  await expect(measureStoredBytes(root, { entries: 100, depth: 3 })).rejects.toBeInstanceOf(
    StorageScanError,
  );
});

it('refuses a directory link that leaves the measured root', async () => {
  const root = await directory();
  const outside = await directory();
  await writeFile(join(outside, 'secret.txt'), 'x'.repeat(50));
  await symlink(outside, join(root, 'link'), 'junction');
  const error = await measureStoredBytes(root).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(StorageScanError);
  expect(String(error)).not.toContain('secret');
  expect(String(error)).not.toContain(outside);
  expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toHaveLength(50);
});

it('reports free space as a safe integer, including a missing nested path', async () => {
  const free = await measureFreeBytes(tmpdir());
  expect(Number.isSafeInteger(free)).toBe(true);
  expect(free).toBeGreaterThan(1_000_000);
  const nested = await measureFreeBytes(join(tmpdir(), 'sf-missing-budget', 'nested', 'dir'));
  expect(Number.isSafeInteger(nested)).toBe(true);
  expect(nested).toBeGreaterThan(1_000_000);
});

it('caps block arithmetic at the safe integer maximum', () => {
  expect(freeSpaceBytes(0n, 4096n)).toBe(0);
  expect(freeSpaceBytes(-1n, 4096n)).toBe(0);
  expect(freeSpaceBytes(10n, 4096n)).toBe(40960);
  expect(freeSpaceBytes(BigInt(Number.MAX_SAFE_INTEGER), 2n)).toBe(Number.MAX_SAFE_INTEGER);
});
