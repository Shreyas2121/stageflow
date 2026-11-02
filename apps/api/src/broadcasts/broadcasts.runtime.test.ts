import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import type { Repository } from 'typeorm';
import type { RoomsService } from '../rooms/rooms.service';
import type { Broadcast } from './broadcast.entity';
import { BroadcastsService, type BroadcastHooks } from './broadcasts.service';
import { FfmpegSupervisor } from './ffmpeg-supervisor';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(stdin = new PassThrough()) {
  const root = await mkdtemp(join(tmpdir(), 'sf-cast-'));
  roots.push(root);
  const rows: Broadcast[] = [];
  const events: string[] = [];
  const repository = {
    create: (value: unknown) => value,
    save: vi.fn(async (row: Broadcast) => {
      if (!row.id) {
        row.id = randomUUID();
        row.createdAt = new Date();
        rows.push(row);
      }
      events.push(row.status);
      return row;
    }),
    delete: vi.fn(),
    findOneBy: vi.fn(async () => rows[0] ?? null),
    findOne: vi.fn(async () => rows[0] ?? null),
  };
  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  });
  const spawn = vi.fn(() => {
    expect(events).toEqual(expect.arrayContaining(['STARTING', 'reserve']));
    queueMicrotask(() => child.emit('spawn'));
    return child as unknown as ChildProcessWithoutNullStreams;
  });
  const supervisor = new FfmpegSupervisor('ffmpeg-test', spawn, 100, 100);
  const service = new BroadcastsService(
    repository as unknown as Repository<Broadcast>,
    {} as RoomsService,
    () => supervisor,
    root,
  );
  const tasks: Promise<void>[] = [];
  const hooks: BroadcastHooks = {
    reserve: vi.fn(async () => {
      events.push('reserve');
      return true;
    }),
    clear: vi.fn(async () => {}),
    publish: vi.fn(async () => {}),
    onExit: (action) => {
      tasks.push(action());
    },
  };
  const start = () => service.start(randomUUID(), 'host', hooks);
  return { root, rows, events, repository, child, spawn, supervisor, service, hooks, tasks, start };
}

it('loads an unknown room projection once and does not keep a reservation that failed', async () => {
  const f = await fixture();
  expect(await f.service.snapshot('room-1', null)).toBeNull();
  expect(f.repository.findOne).toHaveBeenCalledTimes(1);
  expect(f.repository.findOneBy).not.toHaveBeenCalled();
  expect(await f.service.snapshot('room-1', null)).toBeNull();
  expect(f.repository.findOne).toHaveBeenCalledTimes(1);
  vi.mocked(f.hooks.reserve).mockResolvedValueOnce(false);
  expect(await f.service.start('room-2', 'host', f.hooks)).toMatchObject({
    error: 'broadcast_active',
  });
  expect(f.repository.delete).toHaveBeenCalledOnce();
  expect(f.repository.findOneBy).not.toHaveBeenCalled();
  await f.service.snapshot('room-2', null);
  expect(f.repository.findOne).toHaveBeenCalledTimes(2);
});

it('inserts STARTING and reserves before spawn, then marks LIVE and publishes', async () => {
  const f = await fixture();
  expect(await f.start()).toEqual({ ok: true });
  expect(f.events).toEqual(['STARTING', 'reserve', 'LIVE']);
  expect(f.repository.findOne).not.toHaveBeenCalled();
  expect(f.repository.findOneBy).not.toHaveBeenCalled();
  expect(await f.service.snapshot(f.rows[0]!.roomId, f.rows[0]!.id)).toMatchObject({
    status: 'LIVE',
    playlistUrl: `/api/broadcasts/${f.rows[0]!.id}/hls/index.m3u8`,
  });
  expect(await f.service.snapshot(f.rows[0]!.roomId, null)).toMatchObject({ status: 'LIVE' });
  expect(f.repository.findOne).not.toHaveBeenCalled();
  expect(f.repository.findOneBy).not.toHaveBeenCalled();
  f.child.emit('close', 1);
  await vi.waitFor(() => expect(f.tasks).toHaveLength(1));
  await Promise.all(f.tasks);
  expect(f.rows[0]).toMatchObject({ status: 'FAILED', errorMessage: 'FFmpeg exited before stop.' });
  expect(f.hooks.clear).toHaveBeenCalledWith(f.rows[0]!.id);
  expect(f.spawn).toHaveBeenCalledOnce();
});

it('records missing-binary failure, clears the key, and names the binary', async () => {
  const f = await fixture();
  f.spawn.mockImplementationOnce(() => {
    queueMicrotask(() => {
      f.child.emit('error', new Error('ENOENT'));
      f.child.emit('close', null);
    });
    return f.child as unknown as ChildProcessWithoutNullStreams;
  });
  expect(await f.start()).toMatchObject({ ok: false, error: 'ffmpeg_unavailable' });
  expect(f.rows[0]).toMatchObject({ status: 'FAILED', playlistPath: null });
  expect(f.rows[0]!.errorMessage).toContain('ffmpeg-test');
  expect(f.hooks.clear).toHaveBeenCalledOnce();
});

it('writes accepted chunks once and refuses conflicts, future, oversize, and non-host uploads', async () => {
  const f = await fixture();
  await f.start();
  const id = f.rows[0]!.id;
  const body = Buffer.from('webm header');
  await expect(f.service.upload(id, 'guest', 0, body)).rejects.toMatchObject({
    response: { statusCode: 403 },
  });
  await expect(f.service.upload(id, 'host', 1, body)).rejects.toMatchObject({
    response: { statusCode: 409 },
  });
  await expect(f.service.upload(id, 'host', 0, Buffer.alloc(2_000_001))).rejects.toMatchObject({
    response: { statusCode: 413 },
  });
  await expect(f.service.upload(id, 'host', -1, body)).rejects.toMatchObject({
    response: { statusCode: 400 },
  });
  await f.service.upload(id, 'host', 0, body);
  await f.service.upload(id, 'host', 0, body);
  await expect(f.service.upload(id, 'host', 0, Buffer.from('changed'))).rejects.toMatchObject({
    response: { statusCode: 409 },
  });
  const second = Buffer.from('next');
  await f.service.upload(id, 'host', 1, second);
  expect(f.child.stdin.read()).toEqual(Buffer.concat([body, second]));
  expect(f.supervisor.history.nextExpected).toBe(2);
  f.child.emit('close', 1);
  await vi.waitFor(() => expect(f.tasks).toHaveLength(1));
  await Promise.all(f.tasks);
});

it('serializes admission while a write is pending and rejects late chunks after stop', async () => {
  let release!: (error?: Error | null) => void;
  const input = new Writable({
    write(_bytes, _encoding, callback) {
      release = callback;
    },
  });
  const f = await fixture(input as PassThrough);
  await f.start();
  const id = f.rows[0]!.id;
  const pending = f.service.upload(id, 'host', 0, Buffer.from('first'));
  await expect(f.service.upload(id, 'host', 1, Buffer.from('second'))).rejects.toMatchObject({
    response: { statusCode: 409 },
  });
  release();
  await pending;
  f.child.stdin.once('finish', () => f.child.emit('close', 0));
  await f.service.stopRoom(f.rows[0]!.roomId);
  expect(f.rows[0]!.status).toBe('FAILED'); // A successful exit without a playlist is not a replay.
  await expect(f.service.upload(id, 'host', 1, Buffer.from('late'))).rejects.toMatchObject({
    response: { statusCode: 409 },
  });
});

it('keeps a clean-stop playlist as READY and caps a failed process stderr', async () => {
  const f = await fixture();
  await f.start();
  const row = f.rows[0]!;
  await writeFile(join(f.root, 'broadcasts', row.id, 'index.m3u8'), '#EXTM3U\n#EXT-X-ENDLIST\n');
  f.child.stdin.once('finish', () => f.child.emit('close', 0));
  await f.service.stopRoom(row.roomId);
  expect(row).toMatchObject({
    status: 'READY',
    thumbnailPath: null,
    errorMessage: null,
    playlistPath: `broadcasts/${row.id}/index.m3u8`,
  });
  expect(f.events).toEqual(['STARTING', 'reserve', 'LIVE', 'STOPPING', 'READY']);
  expect(f.hooks.clear).toHaveBeenCalledOnce();
  const failed = await fixture();
  await failed.start();
  failed.child.stderr.write('x'.repeat(3000));
  failed.child.emit('close', 9);
  await vi.waitFor(() => expect(failed.tasks).toHaveLength(1));
  await Promise.all(failed.tasks);
  expect(failed.rows[0]).toMatchObject({ status: 'FAILED', errorMessage: 'x'.repeat(2000) });
});

it('closes input on API shutdown and refuses new starts while leaving catalog recovery to startup', async () => {
  const f = await fixture();
  await f.start();
  f.child.stdin.once('finish', () => f.child.emit('close', 0));
  await f.service.onModuleDestroy();
  expect(f.child.stdin.writableEnded).toBe(true);
  expect(f.rows[0]!.status).toBe('LIVE');
  expect(f.hooks.clear).not.toHaveBeenCalled();
  expect(await f.start()).toMatchObject({ ok: false, error: 'server_error' });
  expect(f.rows).toHaveLength(1);
});
