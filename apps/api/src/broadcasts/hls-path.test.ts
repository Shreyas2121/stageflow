import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import {
  broadcastDirectory,
  checkedHlsPath,
  checkedThumbnailPath,
  hlsHeaders,
  hlsPath,
  prepareBroadcastDirectory,
  thumbnailPath,
} from './hls-path';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it('confines every output and rejects traversal, absolute paths, and non-media files', () => {
  const id = randomUUID();
  expect(hlsPath('data', id, 'index.m3u8')).toBe(resolve('data', 'broadcasts', id, 'index.m3u8'));
  for (const file of [
    '../index.m3u8',
    '..\\index.m3u8',
    '/index.m3u8',
    'C:\\index.m3u8',
    '%2e%2e',
    'secret.txt',
    'thumbnail.jpg',
    '.',
    '',
  ])
    expect(() => hlsPath('data', id, file)).toThrow();
  expect(thumbnailPath('data', id, 'thumbnail.jpg')).toBe(
    resolve('data', 'broadcasts', id, 'thumbnail.jpg'),
  );
  for (const file of [
    '../thumbnail.jpg',
    '..\\thumbnail.jpg',
    '/thumbnail.jpg',
    'thumbnail.JPG',
    'index.m3u8',
    'thumbnail.jpg/../secret.txt',
    '.',
    '',
  ])
    expect(() => thumbnailPath('data', id, file)).toThrow();
  expect(() => thumbnailPath('data', '../escape', 'thumbnail.jpg')).toThrow();
  expect(() => broadcastDirectory('data', '../escape')).toThrow();
  expect(() => broadcastDirectory('data', '/tmp')).toThrow();
  expect(hlsPath('data', id, 'segment000001.ts')).toBe(
    resolve('data', 'broadcasts', id, 'segment000001.ts'),
  );
});

it('checks real paths and refuses a junction outside the broadcast directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sf-hls-'));
  roots.push(root);
  const id = randomUUID();
  const directory = await prepareBroadcastDirectory(root, id);
  await writeFile(join(directory, 'index.m3u8'), '#EXTM3U');
  await writeFile(join(directory, 'thumbnail.jpg'), 'jpeg');
  expect(await checkedHlsPath(root, id, 'index.m3u8')).toBe(join(directory, 'index.m3u8'));
  expect(await checkedThumbnailPath(root, id, 'thumbnail.jpg')).toBe(
    join(directory, 'thumbnail.jpg'),
  );
  const other = randomUUID();
  const outside = join(root, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'index.m3u8'), 'secret');
  await symlink(outside, broadcastDirectory(root, other), 'junction');
  await expect(checkedHlsPath(root, other, 'index.m3u8')).rejects.toThrow('Symlink');
  await expect(checkedThumbnailPath(root, other, 'thumbnail.jpg')).rejects.toThrow('Symlink');
  await expect(prepareBroadcastDirectory(root, other)).rejects.toThrow('Symlink');
  await mkdir(join(directory, 'segment000001.ts'));
  await expect(checkedHlsPath(root, id, 'segment000001.ts')).rejects.toThrow('not a file');
  await rm(join(directory, 'thumbnail.jpg'));
  await mkdir(join(directory, 'thumbnail.jpg'));
  await expect(checkedThumbnailPath(root, id, 'thumbnail.jpg')).rejects.toThrow('not a file');
  const linkedRoot = await mkdtemp(join(tmpdir(), 'sf-hls-parent-'));
  roots.push(linkedRoot);
  await symlink(outside, join(linkedRoot, 'broadcasts'), 'junction');
  await expect(prepareBroadcastDirectory(linkedRoot, randomUUID())).rejects.toThrow(
    'Symlink outside data root',
  );
});

it('uses no-cache for playlists and long caching with the two exact MIME types', () => {
  expect(hlsHeaders('index.m3u8')).toEqual({
    'Cache-Control': 'no-cache',
    'Content-Type': 'application/vnd.apple.mpegurl',
  });
  expect(hlsHeaders('segment000001.ts')).toEqual({
    'Cache-Control': 'private, max-age=31536000, immutable',
    'Content-Type': 'video/mp2t',
  });
});
