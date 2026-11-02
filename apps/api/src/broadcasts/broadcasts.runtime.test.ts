import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
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
  const tasks: Promise<unknown>[] = [];
  const hooks: BroadcastHooks = {
    reserve: vi.fn(async () => {
      events.push('reserve');
      return true;
    }),
    clear: vi.fn(async () => {}),
    publish: vi.fn(async () => {}),
    onExit: (action) => {
      // Catch here so a rejected finalization is observable without an unhandled rejection.
      tasks.push(action().catch((error: unknown) => error));
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
  expect(f.tasks).toHaveLength(0);
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

function silenceErrors() {
  return vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
}

it('does not spawn when the insert or reservation fails, and the next start can proceed', async () => {
  const logger = silenceErrors();
  try {
    const inserted = await fixture();
    vi.mocked(inserted.repository.save).mockRejectedValueOnce(new Error('database down'));
    expect(await inserted.service.start('room-a', 'host', inserted.hooks)).toMatchObject({
      error: 'server_error',
    });
    expect(inserted.hooks.reserve).not.toHaveBeenCalled();
    expect(inserted.spawn).not.toHaveBeenCalled();
    expect(await inserted.service.start('room-a', 'host', inserted.hooks)).toEqual({ ok: true });

    const reserved = await fixture();
    vi.mocked(reserved.hooks.reserve).mockRejectedValueOnce(new Error('redis down'));
    expect(await reserved.service.start('room-b', 'host', reserved.hooks)).toMatchObject({
      error: 'server_error',
    });
    expect(reserved.repository.delete).toHaveBeenCalledOnce();
    expect(reserved.spawn).not.toHaveBeenCalled();
    expect(await reserved.service.start('room-b', 'host', reserved.hooks)).toEqual({ ok: true });
  } finally {
    logger.mockRestore();
  }
});

it('releases the reservation when start publication fails before or after the child exists', async () => {
  const logger = silenceErrors();
  try {
    const beforeSpawn = await fixture();
    vi.mocked(beforeSpawn.hooks.publish).mockRejectedValueOnce(new Error('publish failed'));
    expect(await beforeSpawn.start()).toMatchObject({ error: 'ffmpeg_unavailable' });
    expect(beforeSpawn.spawn).not.toHaveBeenCalled();
    expect(beforeSpawn.rows[0]).toMatchObject({ status: 'FAILED' });
    expect(beforeSpawn.hooks.clear).toHaveBeenCalledOnce();
    expect(beforeSpawn.hooks.clear).toHaveBeenCalledWith(beforeSpawn.rows[0]!.id);

    const afterSpawn = await fixture();
    const save = vi.mocked(afterSpawn.repository.save);
    let saves = 0;
    save.mockImplementation(async (row: Broadcast) => {
      saves += 1;
      if (saves === 2) throw new Error('database down');
      if (!row.id) {
        row.id = randomUUID();
        row.createdAt = new Date();
        afterSpawn.rows.push(row);
      }
      afterSpawn.events.push(row.status);
      return row;
    });
    expect(await afterSpawn.start()).toMatchObject({ error: 'ffmpeg_unavailable' });
    expect(afterSpawn.spawn).toHaveBeenCalledOnce();
    expect(afterSpawn.child.kill).toHaveBeenCalled();
    expect(afterSpawn.rows[0]).toMatchObject({ status: 'FAILED' });
    expect(afterSpawn.hooks.clear).toHaveBeenCalledWith(afterSpawn.rows[0]!.id);
  } finally {
    logger.mockRestore();
  }
});

it('stops the child when stop notification fails and finalizes that exit once', async () => {
  const logger = silenceErrors();
  try {
    const saved = await fixture();
    await saved.start();
    vi.mocked(saved.repository.save).mockRejectedValueOnce(new Error('database down'));
    saved.child.stdin.once('finish', () => saved.child.emit('close', 0));
    await saved.service.stopRoom(saved.rows[0]!.roomId);
    expect(saved.supervisor.outcome).toBeDefined();
    expect(saved.child.stdin.writableEnded).toBe(true);
    expect(saved.tasks).toHaveLength(0);
    expect(saved.hooks.clear).toHaveBeenCalledOnce();
    expect(saved.hooks.clear).toHaveBeenCalledWith(saved.rows[0]!.id);

    const published = await fixture();
    await published.start();
    const id = published.rows[0]!.id;
    vi.mocked(published.hooks.publish).mockImplementationOnce(async () => {
      published.child.emit('close', 0);
      throw new Error('publish failed');
    });
    await published.service.stopRoom(published.rows[0]!.roomId);
    expect(published.supervisor.outcome?.premature).toBe(true);
    expect(published.tasks).toHaveLength(0);
    expect(published.hooks.clear).toHaveBeenCalledOnce();
    expect(published.hooks.clear).toHaveBeenCalledWith(id);
    expect(published.rows[0]).toMatchObject({ status: 'FAILED' });
  } finally {
    logger.mockRestore();
  }
});

it('retries finalization and will not clear a newer reservation', async () => {
  const logger = silenceErrors();
  try {
    const retry = await fixture();
    await retry.start();
    vi.mocked(retry.repository.save).mockRejectedValueOnce(new Error('database down'));
    retry.child.emit('close', 1);
    await vi.waitFor(() => expect(retry.tasks).toHaveLength(1));
    await Promise.all(retry.tasks);
    expect(retry.rows[0]).toMatchObject({ status: 'FAILED' });
    expect(retry.hooks.clear).toHaveBeenCalledOnce();
    expect(retry.hooks.clear).toHaveBeenCalledWith(retry.rows[0]!.id);

    const blocked = await fixture();
    await blocked.start();
    const id = blocked.rows[0]!.id;
    let failClear = true;
    vi.mocked(blocked.hooks.clear).mockImplementation(async () => {
      if (failClear) throw new Error('redis down');
    });
    blocked.child.emit('close', 1);
    await vi.waitFor(() => expect(blocked.tasks).toHaveLength(1));
    const failure = await blocked.tasks[0];
    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error)) throw new Error('expected cleanup error');
    expect(failure.message).toBe('redis down');
    expect(blocked.supervisor.outcome).toBeDefined();
    expect(blocked.rows[0]).toMatchObject({ status: 'FAILED' });
    failClear = false;
    await blocked.service.stopRoom(blocked.rows[0]!.roomId);
    expect(blocked.hooks.clear).toHaveBeenCalledWith(id);

    const newer = await fixture();
    await newer.start();
    const attemptId = newer.rows[0]!.id;
    let key = attemptId;
    let calls = 0;
    vi.mocked(newer.hooks.clear).mockImplementation(async (clearId: string) => {
      calls += 1;
      if (calls === 1) {
        key = 'newer-id';
        throw new Error('redis down');
      }
      expect(clearId).toBe(attemptId);
      if (key === clearId) key = 'cleared';
    });
    newer.child.emit('close', 1);
    await vi.waitFor(() => expect(newer.tasks).toHaveLength(1));
    await Promise.all(newer.tasks);
    expect(key).toBe('newer-id');
    expect(newer.hooks.clear).not.toHaveBeenCalledWith('newer-id');
  } finally {
    logger.mockRestore();
  }
});
