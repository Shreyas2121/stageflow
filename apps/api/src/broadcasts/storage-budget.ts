import { lstat, readdir, realpath, statfs } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** A directory past this depth, or more entries than the cap, refuses the recording. */
export const STORAGE_WALK_DEPTH = 3;
export const STORAGE_WALK_LIMIT = 10_000;

export const RECORDING_TIME_MESSAGE = 'This recording reached its time limit.';
export const RECORDING_SIZE_MESSAGE = 'This recording reached its size limit.';

export class StorageScanError extends Error {
  constructor() {
    super('Recording storage could not be measured.');
  }
}

export type RecordingBudget = {
  maxDurationMs: number;
  maxRecordingBytes: number;
  maxStorageBytes: number;
  minFreeBytes: number;
  guestRecordingLimit: number;
  guestStorageBytes: number;
};

export type GuestUsage = { recordings: number; bytes: number };

export type StorageProbe = {
  freeBytes(): Promise<number>;
  storedBytes(): Promise<number>;
  guestUsage?(hostId: string): Promise<GuestUsage>;
};

type WalkLimits = { entries: number; depth: number };

export function recordingBudgetFromEnv(source: {
  RECORDING_MAX_MS: number;
  RECORDING_MAX_BYTES: number;
  STORAGE_MAX_BYTES: number;
  MIN_FREE_BYTES: number;
  GUEST_RECORDING_LIMIT: number;
  GUEST_STORAGE_BYTES: number;
}): RecordingBudget {
  return {
    maxDurationMs: source.RECORDING_MAX_MS,
    maxRecordingBytes: source.RECORDING_MAX_BYTES,
    maxStorageBytes: source.STORAGE_MAX_BYTES,
    minFreeBytes: source.MIN_FREE_BYTES,
    guestRecordingLimit: source.GUEST_RECORDING_LIMIT,
    guestStorageBytes: source.GUEST_STORAGE_BYTES,
  };
}

export function diskStorageProbe(dataRoot: string): StorageProbe {
  return {
    freeBytes: () => measureFreeBytes(dataRoot),
    storedBytes: () => measureStoredBytes(join(dataRoot, 'broadcasts')),
  };
}

/** Block count times block size, capped so a huge volume stays a safe integer. */
export function freeSpaceBytes(available: bigint, blockSize: bigint): number {
  if (available <= 0n || blockSize <= 0n) return 0;
  const product = available * blockSize;
  const max = BigInt(Number.MAX_SAFE_INTEGER);
  return product > max ? Number.MAX_SAFE_INTEGER : Number(product);
}

export async function measureFreeBytes(path: string): Promise<number> {
  let current = resolve(path);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      const stats = await statfs(current, { bigint: true });
      return freeSpaceBytes(stats.bavail, stats.bsize);
    } catch (error) {
      if (!isEnoent(error)) throw new StorageScanError();
      const parent = dirname(current);
      if (parent === current) throw new StorageScanError();
      current = parent;
    }
  }
  throw new StorageScanError();
}

/**
 * Sum regular files under a broadcast directory. Links and directories outside the root refuse
 * the measurement. Nothing is deleted.
 */
export async function measureStoredBytes(
  root: string,
  limits: WalkLimits = { entries: STORAGE_WALK_LIMIT, depth: STORAGE_WALK_DEPTH },
): Promise<number> {
  const resolved = await locate(root);
  if (!resolved) return 0;
  let seen = 0;
  let total = 0;

  const visit = async (directory: string, depth: number): Promise<void> => {
    let listing;
    try {
      listing = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isEnoent(error)) return;
      throw new StorageScanError();
    }
    for (const entry of listing) {
      seen += 1;
      if (seen > limits.entries) throw new StorageScanError();
      if (entry.name === '.' || entry.name === '..') continue;
      if (entry.name.includes('/') || entry.name.includes('\\') || entry.name.includes('\0')) {
        throw new StorageScanError();
      }
      if (entry.isSymbolicLink()) throw new StorageScanError();
      const full = join(directory, entry.name);
      let stats;
      try {
        stats = await lstat(full);
      } catch (error) {
        if (isEnoent(error)) continue;
        throw new StorageScanError();
      }
      if (stats.isSymbolicLink()) throw new StorageScanError();
      if (stats.isDirectory()) {
        if (depth + 1 > limits.depth) throw new StorageScanError();
        await assertContained(resolved, full);
        await visit(full, depth + 1);
        continue;
      }
      if (!stats.isFile()) continue;
      total = addBytes(total, stats.size);
    }
  };

  await visit(resolved, 0);
  return total;
}

function addBytes(total: number, size: number): number {
  if (!Number.isSafeInteger(size) || size < 0) throw new StorageScanError();
  const next = total + size;
  if (!Number.isSafeInteger(next)) return Number.MAX_SAFE_INTEGER;
  return next;
}

async function locate(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch (error) {
    if (isEnoent(error)) return null;
    throw new StorageScanError();
  }
}

async function assertContained(root: string, directory: string): Promise<void> {
  let real: string;
  try {
    real = await realpath(directory);
  } catch (error) {
    if (isEnoent(error)) return;
    throw new StorageScanError();
  }
  const part = relative(root, real);
  if (part === '..' || part.startsWith(`..${sep}`) || part.startsWith('../') || isAbsolute(part)) {
    throw new StorageScanError();
  }
}

function isEnoent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
