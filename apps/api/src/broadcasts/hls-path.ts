import { isUuid } from '@stageflow/shared';
import { mkdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

function inside(root: string, path: string): void {
  const part = relative(root, path);
  if (
    !part ||
    part === '..' ||
    part.startsWith('..\\') ||
    part.startsWith('../') ||
    isAbsolute(part)
  )
    throw new Error('Broadcast path escapes its data directory.');
}

export function broadcastDirectory(dataRoot: string, id: string): string {
  if (!isUuid(id)) throw new Error('Invalid broadcast id.');
  const root = resolve(dataRoot);
  const directory = resolve(root, 'broadcasts', id);
  inside(root, directory);
  return directory;
}

export function hlsPath(dataRoot: string, id: string, file: string): string {
  if (!/^(index\.m3u8|segment\d{6,}\.ts)$/.test(file)) throw new Error('Invalid HLS filename.');
  const directory = broadcastDirectory(dataRoot, id);
  const path = resolve(directory, file);
  inside(directory, path);
  return path;
}

async function checkDirectory(dataRoot: string, id: string): Promise<string> {
  const root = await realpath(dataRoot);
  const directory = await realpath(broadcastDirectory(dataRoot, id));
  if (directory !== resolve(root, 'broadcasts', id))
    throw new Error('Symlink outside broadcast directory.');
  return directory;
}

export async function prepareBroadcastDirectory(dataRoot: string, id: string): Promise<string> {
  broadcastDirectory(dataRoot, id);
  await mkdir(dataRoot, { recursive: true });
  const root = await realpath(dataRoot);
  const parent = resolve(dataRoot, 'broadcasts');
  await mkdir(parent, { recursive: true });
  if ((await realpath(parent)) !== resolve(root, 'broadcasts'))
    throw new Error('Symlink outside data root.');
  await mkdir(broadcastDirectory(dataRoot, id), { recursive: true });
  return checkDirectory(dataRoot, id);
}

export async function checkedHlsPath(dataRoot: string, id: string, file: string): Promise<string> {
  hlsPath(dataRoot, id, file);
  const directory = await checkDirectory(dataRoot, id);
  const path = await realpath(resolve(directory, file));
  inside(directory, path);
  if (!(await stat(path)).isFile()) throw new Error('HLS path is not a file.');
  return path;
}

export function hlsHeaders(file: string): Record<string, string> {
  return file === 'index.m3u8'
    ? { 'Cache-Control': 'no-cache', 'Content-Type': 'application/vnd.apple.mpegurl' }
    : { 'Cache-Control': 'private, max-age=31536000, immutable', 'Content-Type': 'video/mp2t' };
}
