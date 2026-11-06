import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import type { Repository } from 'typeorm';
import type { RoomsService } from '../rooms/rooms.service';
import type { Broadcast } from './broadcast.entity';
import { UploadAllowance } from '../admission/upload-allowance';
import { failure } from '../live/signaling.messages';
import { BroadcastsService, type BroadcastHooks } from './broadcasts.service';
import { EncoderBudget } from './encoder-budget';
import { FfmpegSupervisor, PRODUCER_IDLE_MS } from './ffmpeg-supervisor';
import {
  RECORDING_SIZE_MESSAGE,
  RECORDING_TIME_MESSAGE,
  StorageScanError,
  type RecordingBudget,
  type StorageProbe,
} from './storage-budget';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function budget(overrides: Partial<RecordingBudget> = {}): RecordingBudget {
  return {
    maxDurationMs: 900_000,
    maxRecordingBytes: 268_435_456,
    maxStorageBytes: 1_073_741_824,
    minFreeBytes: 536_870_912,
    guestRecordingLimit: 3,
    guestStorageBytes: 268_435_456,
    ...overrides,
  };
}

function openStorage(guestUsage?: StorageProbe['guestUsage']): StorageProbe {
  return {
    freeBytes: async () => 1_000_000_000_000,
    storedBytes: async () => 0,
    ...(guestUsage ? { guestUsage } : {}),
  };
}

async function fixture(
  stdin = new PassThrough(),
  uploads?: UploadAllowance,
  encoders?: EncoderBudget,
  recording?: RecordingBudget,
  storage?: StorageProbe,
) {
  const root = await mkdtemp(join(tmpdir(), 'sf-cast-'));
  roots.push(root);
  const rows: Broadcast[] = [];
  const events: string[] = [];
  const repository = {
    create: (value: unknown) => value,
    save: vi.fn(async (row: Broadcast) => {
      if (!row.id) {
        row.visibility ??= 'LINK';
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
    createQueryBuilder: vi.fn((): unknown => {
      throw new Error('unexpected guest recording query');
    }),
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
    uploads,
    undefined,
    encoders,
    recording,
    storage,
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
  expect(f.hooks.clear).not.toHaveBeenCalled();
  expect(f.repository.findOneBy).not.toHaveBeenCalled();
  await f.service.snapshot('room-2', null);
  expect(f.repository.findOne).toHaveBeenCalledTimes(2);
});

it('aborts an interrupted host broadcast as FAILED and rejects every later chunk', async () => {
  const f = await fixture();
  expect(await f.start()).toEqual({ ok: true });
  const row = f.rows[0]!;
  // Even a complete playlist must not turn unexpected host loss into a READY attempt.
  await writeFile(join(f.root, 'broadcasts', row.id, 'index.m3u8'), '#EXTM3U\n#EXT-X-ENDLIST\n');
  await f.service.failInterrupted(row.roomId);
  expect(f.child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
  expect(row).toMatchObject({
    status: 'FAILED',
    errorMessage: 'Host connection lost.',
    playlistPath: null,
  });
  expect(row.endedAt).toBeInstanceOf(Date);
  expect(f.hooks.clear).toHaveBeenCalledExactlyOnceWith(row.id);
  await expect(f.service.upload(row.id, 'host', 0, Buffer.from('late'))).rejects.toMatchObject({
    response: { error: 'broadcast_not_active' },
  });
  await f.service.stopRoom(row.roomId);
  expect(row.status).toBe('FAILED');
});

it('inserts STARTING and reserves before spawn, then marks LIVE and publishes', async () => {
  const f = await fixture();
  expect(await f.start()).toEqual({ ok: true });
  expect(f.events).toEqual(['STARTING', 'reserve', 'LIVE']);
  expect(f.rows[0]?.visibility).toBe('LINK');
  expect(f.repository.save.mock.calls[0]?.[0].visibility).toBe('LINK');
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

it('finalizes producer loss once, clears its reservation, and publishes FAILED', async () => {
  const f = await fixture();
  expect(await f.start()).toEqual({ ok: true });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    // Renew under the controlled clock; the startup timer was created before it.
    await f.service.upload(f.rows[0]!.id, 'host', 0, Buffer.from('webm'));
    await vi.advanceTimersByTimeAsync(PRODUCER_IDLE_MS);
    await Promise.all(f.tasks);
    expect(f.rows[0]).toMatchObject({
      status: 'FAILED',
      errorMessage: 'Broadcast producer stopped sending media.',
    });
    expect(f.hooks.clear).toHaveBeenCalledExactlyOnceWith(f.rows[0]!.id);
    expect(f.hooks.publish).toHaveBeenCalledTimes(3);
    f.child.emit('close', 0);
    await f.service.stopRoom(f.rows[0]!.roomId);
    expect(f.hooks.clear).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
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

it('charges only the authenticated host and limits that attempt', async () => {
  let now = 0;
  const f = await fixture(
    undefined,
    new UploadAllowance(
      {
        UPLOAD_USER_RATE_LIMIT: 1,
        UPLOAD_ATTEMPT_RATE_LIMIT: 1,
        RATE_WINDOW_MS: 60_000,
        RATE_KEYS_MAX: 10,
      },
      () => now,
    ),
  );
  await f.start();
  const id = f.rows[0]!.id;
  const body = Buffer.from('webm');
  await expect(f.service.upload(id, 'guest', 0, body)).rejects.toMatchObject({
    response: { statusCode: 403, error: 'not_host' },
  });
  await f.service.upload(id, 'host', 0, body);
  await expect(f.service.upload(id, 'host', 1, Buffer.from('next'))).rejects.toMatchObject({
    retryAfterSeconds: 60,
    response: { statusCode: 429, error: 'rate_limited' },
  });
  now = 60_000;
  await f.service.upload(id, 'host', 1, Buffer.from('next'));
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
  const ledger = f.supervisor.history.acceptedHashes;
  await vi.waitFor(() => expect(typeof release).toBe('function'));
  expect(ledger.size).toBe(0);
  expect(f.supervisor.history.nextExpected).toBe(0);
  await expect(f.service.upload(id, 'host', 1, Buffer.from('second'))).rejects.toMatchObject({
    response: { statusCode: 409 },
  });
  release();
  await pending;
  expect(f.supervisor.history.acceptedHashes).toBe(ledger);
  expect(ledger.size).toBe(1);
  expect(f.supervisor.history.nextExpected).toBe(1);
  f.child.stdin.once('finish', () => f.child.emit('close', 0));
  await f.service.stopRoom(f.rows[0]!.roomId);
  expect(f.rows[0]!.status).toBe('FAILED'); // A successful exit without a playlist is not a replay.
  await expect(f.service.upload(id, 'host', 1, Buffer.from('late'))).rejects.toMatchObject({
    response: { statusCode: 409 },
  });
});

it('does not commit a hash or advance sequence when the input write fails', async () => {
  const f = await fixture();
  await f.start();
  vi.spyOn(f.supervisor, 'write').mockRejectedValueOnce(new Error('write failed'));
  const id = f.rows[0]!.id;
  await expect(f.service.upload(id, 'host', 0, Buffer.from('first'))).rejects.toThrow(
    'write failed',
  );
  expect(f.supervisor.history.nextExpected).toBe(0);
  expect(f.supervisor.history.acceptedHashes.size).toBe(0);
  expect(f.supervisor.writing).toBe(false);
  await f.service.upload(id, 'host', 0, Buffer.from('retry'));
  expect(f.supervisor.history.nextExpected).toBe(1);
  expect(f.supervisor.history.acceptedHashes.size).toBe(1);
  f.child.emit('close', 1);
  await Promise.all(f.tasks);
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

it('reserves encoder capacity before setup and releases it on success, rejection, and shutdown', async () => {
  const global = new EncoderBudget(1, 1);
  const saturated = await fixture(undefined, undefined, global);
  expect(await saturated.service.start(randomUUID(), 'ava', saturated.hooks)).toEqual({
    ok: true,
  });
  expect(global.active).toBe(1);
  expect(await saturated.service.start(randomUUID(), 'sam', saturated.hooks)).toMatchObject({
    error: 'encoder_capacity',
    message: 'Recording capacity is full. Try again shortly.',
  });
  expect(saturated.spawn).toHaveBeenCalledOnce();
  expect(saturated.rows).toHaveLength(1);
  saturated.child.emit('close', 1);
  await vi.waitFor(() => expect(saturated.tasks).toHaveLength(1));
  await Promise.all(saturated.tasks);
  expect(global.active).toBe(0);
  expect(global.principals).toBe(0);

  const principal = new EncoderBudget(2, 1);
  const sameHost = await fixture(undefined, undefined, principal);
  expect(await sameHost.start()).toEqual({ ok: true });
  expect(await sameHost.service.start(randomUUID(), 'host', sameHost.hooks)).toMatchObject({
    error: 'encoder_capacity',
  });
  expect(sameHost.spawn).toHaveBeenCalledOnce();
  expect(sameHost.rows).toHaveLength(1);

  const rejectedBudget = new EncoderBudget(1, 1);
  const rejected = await fixture(undefined, undefined, rejectedBudget);
  vi.mocked(rejected.hooks.reserve).mockResolvedValueOnce(false);
  expect(await rejected.service.start('room-full', 'host', rejected.hooks)).toMatchObject({
    error: 'broadcast_active',
  });
  expect(rejected.spawn).not.toHaveBeenCalled();
  expect(rejected.repository.delete).toHaveBeenCalledOnce();
  expect(rejectedBudget.active).toBe(0);
  expect(rejectedBudget.principals).toBe(0);

  const stoppingBudget = new EncoderBudget(1, 1);
  const stopping = await fixture(undefined, undefined, stoppingBudget);
  await stopping.start();
  expect(stoppingBudget.active).toBe(1);
  stopping.child.stdin.once('finish', () => stopping.child.emit('close', 0));
  await stopping.service.onModuleDestroy();
  expect(stoppingBudget.active).toBe(0);
  expect(stoppingBudget.principals).toBe(0);
});

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

it('clears a reservation that committed before its reply was lost', async () => {
  const logger = silenceErrors();
  try {
    const f = await fixture();
    const roomId = 'room-lost';
    const claims = new Set<string>();
    vi.mocked(f.hooks.reserve).mockImplementationOnce(async (id: string) => {
      claims.add(id);
      throw new Error('reply lost');
    });
    vi.mocked(f.hooks.clear).mockImplementation(async (id: string) => {
      claims.delete(id);
    });
    expect(await f.service.start(roomId, 'host', f.hooks)).toMatchObject({ error: 'server_error' });
    const id = f.rows[0]!.id;
    expect(claims.has(id)).toBe(false);
    expect(f.hooks.clear).toHaveBeenCalledExactlyOnceWith(id);
    expect(f.repository.delete).toHaveBeenCalledExactlyOnceWith(id);
    expect(f.hooks.publish).not.toHaveBeenCalled();
    expect(f.spawn).not.toHaveBeenCalled();
    await f.service.stopRoom(roomId);
    await f.service.stopRoom(roomId);
    expect(f.hooks.clear).toHaveBeenCalledOnce();
    expect(await f.service.start(roomId, 'host', f.hooks)).toEqual({ ok: true });
    expect(f.spawn).toHaveBeenCalledOnce();
    expect(f.rows).toHaveLength(2);
  } finally {
    logger.mockRestore();
  }
});

it('retries a conditional clear once and then lets the next start proceed', async () => {
  const logger = silenceErrors();
  try {
    const f = await fixture();
    const roomId = 'room-clear-once';
    const claims = new Set<string>();
    let clears = 0;
    vi.mocked(f.hooks.reserve).mockImplementationOnce(async (id: string) => {
      claims.add(id);
      throw new Error('reply lost');
    });
    vi.mocked(f.hooks.clear).mockImplementation(async (id: string) => {
      clears += 1;
      if (clears === 1) throw new Error('redis down');
      claims.delete(id);
    });
    expect(await f.service.start(roomId, 'host', f.hooks)).toMatchObject({ error: 'server_error' });
    expect(clears).toBe(2);
    expect(claims.size).toBe(0);
    expect(f.hooks.clear).toHaveBeenCalledTimes(2);
    expect(f.hooks.clear).toHaveBeenNthCalledWith(1, f.rows[0]!.id);
    expect(f.hooks.clear).toHaveBeenNthCalledWith(2, f.rows[0]!.id);
    expect(f.repository.delete).toHaveBeenCalledExactlyOnceWith(f.rows[0]!.id);
    expect(f.spawn).not.toHaveBeenCalled();
    expect(await f.service.start(roomId, 'host', f.hooks)).toEqual({ ok: true });
    expect(f.hooks.clear).toHaveBeenCalledTimes(2);
    expect(f.spawn).toHaveBeenCalledOnce();
  } finally {
    logger.mockRestore();
  }
});

it('keeps an ambiguous reservation until clear succeeds, and stop retries without a second row', async () => {
  const logger = silenceErrors();
  try {
    const f = await fixture();
    const roomId = 'room-clear-stuck';
    const claims = new Set<string>();
    vi.mocked(f.hooks.reserve).mockImplementationOnce(async (id: string) => {
      claims.add(id);
      throw new Error('reply lost');
    });
    vi.mocked(f.hooks.clear).mockImplementation(async () => {
      throw new Error('redis down');
    });
    expect(await f.service.start(roomId, 'host', f.hooks)).toMatchObject({ error: 'server_error' });
    const id = f.rows[0]!.id;
    expect(f.repository.save).toHaveBeenCalledTimes(1);
    expect(f.hooks.reserve).toHaveBeenCalledTimes(1);
    expect(f.hooks.clear).toHaveBeenCalledTimes(3);
    expect(f.repository.delete).not.toHaveBeenCalled();
    expect(claims.has(id)).toBe(true);
    expect(f.spawn).not.toHaveBeenCalled();

    expect(await f.service.start(roomId, 'host', f.hooks)).toMatchObject({ error: 'server_error' });
    expect(f.rows).toHaveLength(1);
    expect(f.repository.save).toHaveBeenCalledTimes(1);
    expect(f.hooks.reserve).toHaveBeenCalledTimes(1);
    expect(f.hooks.clear).toHaveBeenCalledTimes(6);
    expect(vi.mocked(f.hooks.clear).mock.calls.every(([clearedId]) => clearedId === id)).toBe(true);

    await expect(f.service.stopRoom(roomId)).rejects.toThrow(
      'Broadcast reservation cleanup failed.',
    );
    expect(f.hooks.clear).toHaveBeenCalledTimes(9);
    expect(claims.has(id)).toBe(true);
    await f.service.failInterrupted(roomId);
    expect(f.hooks.clear).toHaveBeenCalledTimes(12);
    expect(f.rows).toHaveLength(1);
    expect(f.child.kill).not.toHaveBeenCalled();

    vi.mocked(f.hooks.clear).mockImplementation(async (clearedId: string) => {
      expect(clearedId).toBe(id);
      claims.delete(clearedId);
    });
    await f.service.stopRoom(roomId);
    expect(claims.size).toBe(0);
    expect(f.repository.delete).toHaveBeenCalledExactlyOnceWith(id);
    await f.service.stopRoom(roomId);
    expect(f.hooks.clear).toHaveBeenCalledTimes(13);
    expect(f.repository.delete).toHaveBeenCalledOnce();
    expect(await f.service.start(roomId, 'host', f.hooks)).toEqual({ ok: true });
    expect(f.rows).toHaveLength(2);
    expect(f.spawn).toHaveBeenCalledOnce();
  } finally {
    logger.mockRestore();
  }
});

it('does not clear a newer claim while reconciling a lost reservation reply', async () => {
  const logger = silenceErrors();
  try {
    const f = await fixture();
    const roomId = 'room-newer-claim';
    let active = '';
    vi.mocked(f.hooks.reserve).mockImplementationOnce(async (id: string) => {
      active = id;
      throw new Error('reply lost');
    });
    vi.mocked(f.hooks.clear).mockImplementation(async (id: string) => {
      active = 'newer-id';
      expect(id).toBe(f.rows[0]!.id);
      if (active === id) active = 'cleared';
    });
    expect(await f.service.start(roomId, 'host', f.hooks)).toMatchObject({ error: 'server_error' });
    expect(active).toBe('newer-id');
    expect(f.hooks.clear).toHaveBeenCalledExactlyOnceWith(f.rows[0]!.id);
    expect(f.hooks.clear).not.toHaveBeenCalledWith('newer-id');
    expect(f.repository.delete).toHaveBeenCalledExactlyOnceWith(f.rows[0]!.id);
    expect(f.spawn).not.toHaveBeenCalled();
    await f.service.stopRoom(roomId);
    await f.service.stopRoom(roomId);
    expect(f.hooks.clear).toHaveBeenCalledOnce();
    expect(active).toBe('newer-id');
  } finally {
    logger.mockRestore();
  }
});

it('keeps the attempt when the row delete reply is lost and does not reserve again', async () => {
  const logger = silenceErrors();
  try {
    const f = await fixture();
    const roomId = 'room-delete-lost';
    const order: string[] = [];
    const claims = new Set<string>();
    let deletes = 0;
    vi.mocked(f.repository.save).mockImplementation(async (row: Broadcast) => {
      order.push('save');
      if (!row.id) {
        row.id = randomUUID();
        row.createdAt = new Date();
        f.rows.push(row);
      }
      f.events.push(row.status);
      return row;
    });
    vi.mocked(f.hooks.reserve).mockImplementation(async (id: string) => {
      order.push('reserve');
      if (order.filter((item) => item === 'reserve').length === 1) {
        claims.add(id);
        throw new Error('reply lost');
      }
      f.events.push('reserve');
      return true;
    });
    vi.mocked(f.hooks.clear).mockImplementation(async (id: string) => {
      order.push('clear');
      claims.delete(id);
    });
    vi.mocked(f.repository.delete).mockImplementation(async () => {
      order.push('delete');
      deletes += 1;
      if (deletes <= 3) throw new Error('delete lost');
    });
    expect(await f.service.start(roomId, 'host', f.hooks)).toMatchObject({ error: 'server_error' });
    expect(order).toEqual(['save', 'reserve', 'clear', 'delete', 'delete', 'delete']);
    expect(claims.size).toBe(0);
    expect(f.rows).toHaveLength(1);
    expect(f.spawn).not.toHaveBeenCalled();

    expect(await f.service.start(roomId, 'host', f.hooks)).toEqual({ ok: true });
    expect(order.slice(6, 9)).toEqual(['delete', 'save', 'reserve']);
    expect(f.rows).toHaveLength(2);
    expect(f.hooks.clear).toHaveBeenCalledOnce();
    expect(f.hooks.reserve).toHaveBeenCalledTimes(2);
    expect(f.spawn).toHaveBeenCalledOnce();
    expect(claims.size).toBe(0);
  } finally {
    logger.mockRestore();
  }
});

it('refuses a start that would exhaust disk or the guest allowance and does not take a slot', async () => {
  const logger = silenceErrors();
  try {
    const fullMessage = failure('storage_full').message;
    const guestUsage = vi.fn(async () => ({ recordings: 0, bytes: 0 }));
    const encoders = new EncoderBudget(1, 1);
    const empty = await fixture(undefined, undefined, encoders, undefined, {
      freeBytes: async () => 0,
      storedBytes: async () => 0,
      guestUsage,
    });
    expect(await empty.service.start(randomUUID(), 'guest-host', empty.hooks, true)).toEqual({
      ok: false,
      error: 'storage_full',
      message: fullMessage,
    });
    expect(empty.spawn).not.toHaveBeenCalled();
    expect(empty.rows).toHaveLength(0);
    expect(encoders.active).toBe(0);
    expect(guestUsage).not.toHaveBeenCalled();
    expect(JSON.stringify(fullMessage)).not.toContain(empty.root);

    const stored = await fixture(undefined, undefined, new EncoderBudget(1, 1), undefined, {
      freeBytes: async () => 1_000_000_000_000,
      storedBytes: async () => 1_073_741_824 - 268_435_456 + 1,
    });
    expect(await stored.start()).toMatchObject({ error: 'storage_full', message: fullMessage });
    expect(stored.spawn).not.toHaveBeenCalled();
    expect(stored.rows).toHaveLength(0);

    const fitting = await fixture(
      undefined,
      undefined,
      new EncoderBudget(1, 1),
      budget({ maxStorageBytes: 100, maxRecordingBytes: 40, minFreeBytes: 0 }),
      { freeBytes: async () => 1_000_000_000_000, storedBytes: async () => 60 },
    );
    expect(await fitting.start()).toEqual({ ok: true });
    expect(fitting.spawn).toHaveBeenCalledOnce();

    const guests = vi.fn(async () => ({ recordings: 3, bytes: 0 }));
    const limited = await fixture(
      undefined,
      undefined,
      new EncoderBudget(1, 1),
      undefined,
      openStorage(guests),
    );
    expect(await limited.service.start(randomUUID(), 'guest-host', limited.hooks, true)).toEqual({
      ok: false,
      error: 'storage_full',
      message: fullMessage,
    });
    expect(limited.spawn).not.toHaveBeenCalled();
    expect(guests).toHaveBeenCalledOnce();
    expect(limited.rows).toHaveLength(0);

    const registered = vi.fn(async () => ({ recordings: 99, bytes: 99 }));
    const host = await fixture(
      undefined,
      undefined,
      new EncoderBudget(1, 1),
      undefined,
      openStorage(registered),
    );
    expect(await host.start()).toEqual({ ok: true });
    expect(registered).not.toHaveBeenCalled();
    expect(host.repository.createQueryBuilder).not.toHaveBeenCalled();

    const scanned = await fixture(undefined, undefined, new EncoderBudget(1, 1), undefined, {
      freeBytes: async () => {
        throw new StorageScanError();
      },
      storedBytes: async () => 0,
    });
    expect(await scanned.start()).toEqual({
      ok: false,
      error: 'storage_full',
      message: fullMessage,
    });
    expect(scanned.spawn).not.toHaveBeenCalled();
    expect(JSON.stringify(failure('storage_full'))).not.toContain(scanned.root);

    let probePath = '';
    const broken = await fixture(undefined, undefined, new EncoderBudget(1, 1), undefined, {
      freeBytes: async () => {
        throw new Error(`missing ${probePath}`);
      },
      storedBytes: async () => 0,
    });
    probePath = broken.root;
    const brokenResult = await broken.start();
    expect(brokenResult).toEqual({
      ok: false,
      error: 'server_error',
      message: failure('server_error').message,
    });
    expect(JSON.stringify(brokenResult)).not.toContain(broken.root);
    expect(broken.spawn).not.toHaveBeenCalled();
    expect(broken.rows).toHaveLength(0);
  } finally {
    logger.mockRestore();
  }
});

it('rechecks the guest allowance after the slot is reserved and releases that slot', async () => {
  let calls = 0;
  const encoders = new EncoderBudget(1, 1);
  const f = await fixture(undefined, undefined, encoders, undefined, {
    freeBytes: async () => 1_000_000_000_000,
    storedBytes: async () => 0,
    guestUsage: async () => {
      calls += 1;
      return { recordings: calls === 1 ? 0 : 3, bytes: 0 };
    },
  });
  expect(await f.service.start(randomUUID(), 'guest-host', f.hooks, true)).toEqual({
    ok: false,
    error: 'storage_full',
    message: failure('storage_full').message,
  });
  expect(calls).toBe(2);
  expect(f.spawn).not.toHaveBeenCalled();
  expect(f.rows).toHaveLength(0);
  expect(encoders.active).toBe(0);
  expect(encoders.principals).toBe(0);
});

it('counts a guest host from the catalog and retained files, and serializes the next guest start', async () => {
  const logger = silenceErrors();
  try {
    const encoders = new EncoderBudget(2, 2);
    const recording = budget({ guestRecordingLimit: 3, guestStorageBytes: 10, minFreeBytes: 0 });
    const kept = randomUUID();
    const f = await fixture(undefined, undefined, encoders, recording, openStorage());
    await mkdir(join(f.root, 'broadcasts', kept), { recursive: true });
    await writeFile(join(f.root, 'broadcasts', kept, 'segment.ts'), 'x'.repeat(11));
    const chain = {
      innerJoin: vi.fn(),
      where: vi.fn(),
      andWhere: vi.fn(),
      orderBy: vi.fn(),
      addOrderBy: vi.fn(),
      limit: vi.fn(),
      getMany: vi.fn(async () => [{ id: kept }]),
    };
    for (const method of [
      chain.innerJoin,
      chain.where,
      chain.andWhere,
      chain.orderBy,
      chain.addOrderBy,
      chain.limit,
    ]) {
      method.mockReturnValue(chain);
    }
    f.repository.createQueryBuilder.mockReturnValue(chain);
    expect(await f.service.start(randomUUID(), 'guest-host', f.hooks, true)).toEqual({
      ok: false,
      error: 'storage_full',
      message: failure('storage_full').message,
    });
    expect(f.repository.createQueryBuilder).toHaveBeenCalledWith('broadcast');
    expect(chain.innerJoin).toHaveBeenCalledWith('broadcast.room', 'room');
    expect(chain.where).toHaveBeenCalledWith('room.hostId = :hostId', { hostId: 'guest-host' });
    expect(chain.andWhere).toHaveBeenCalledWith('broadcast.status != :deleting', {
      deleting: 'DELETING',
    });
    expect(chain.limit).toHaveBeenCalledWith(3);
    expect(f.spawn).not.toHaveBeenCalled();
    expect(await readFile(join(f.root, 'broadcasts', kept, 'segment.ts'), 'utf8')).toHaveLength(11);
    expect(encoders.active).toBe(0);

    let calls = 0;
    let releaseReserve!: () => void;
    const reserveGate = new Promise<void>((resolve) => {
      releaseReserve = resolve;
    });
    const queued = await fixture(
      undefined,
      undefined,
      new EncoderBudget(2, 2),
      budget({ guestRecordingLimit: 1, minFreeBytes: 0 }),
      openStorage(async () => {
        calls += 1;
        return { recordings: calls > 2 ? 1 : 0, bytes: 0 };
      }),
    );
    vi.mocked(queued.hooks.reserve).mockImplementation(async () => {
      queued.events.push('reserve');
      await reserveGate;
      return true;
    });
    const first = queued.service.start(randomUUID(), 'guest-host', queued.hooks, true);
    await vi.waitFor(() => expect(queued.events).toContain('reserve'));
    expect(calls).toBe(2);
    const second = queued.service.start(randomUUID(), 'guest-host', queued.hooks, true);
    await new Promise((resolve) => setImmediate(resolve));
    expect(calls).toBe(2);
    releaseReserve();
    expect(await first).toEqual({ ok: true });
    expect(await second).toEqual({
      ok: false,
      error: 'storage_full',
      message: failure('storage_full').message,
    });
    expect(queued.spawn).toHaveBeenCalledOnce();
    queued.child.emit('close', 1);
    await vi.waitFor(() => expect(queued.tasks).toHaveLength(1));
    await Promise.all(queued.tasks);
  } finally {
    logger.mockRestore();
  }
});

async function readyPlaylist(root: string, id: string): Promise<void> {
  await writeFile(join(root, 'broadcasts', id, 'index.m3u8'), '#EXTM3U\n#EXT-X-ENDLIST\n');
}

it('finalizes a recording that would pass its size, duration, guest, or free-space budget', async () => {
  const logger = silenceErrors();
  try {
    const sized = await fixture(
      undefined,
      undefined,
      new EncoderBudget(1, 1),
      budget({ maxRecordingBytes: 4, minFreeBytes: 0 }),
      openStorage(),
    );
    expect(await sized.start()).toEqual({ ok: true });
    const sizedRow = sized.rows[0]!;
    await sized.service.upload(sizedRow.id, 'host', 0, Buffer.from('abcd'));
    await readyPlaylist(sized.root, sizedRow.id);
    sized.child.stdin.once('finish', () => sized.child.emit('close', 0));
    await expect(
      sized.service.upload(sizedRow.id, 'host', 1, Buffer.from('e')),
    ).rejects.toMatchObject({
      response: { statusCode: 409, error: 'recording_limit', message: RECORDING_SIZE_MESSAGE },
    });
    expect(sized.child.stdin.read()).toEqual(Buffer.from('abcd'));
    expect(sizedRow).toMatchObject({ status: 'READY', errorMessage: null });
    expect(sized.supervisor.history.nextExpected).toBe(1);

    const timed = await fixture(
      undefined,
      undefined,
      new EncoderBudget(1, 1),
      budget({ maxDurationMs: 1000, minFreeBytes: 0 }),
      openStorage(),
    );
    expect(await timed.start()).toEqual({ ok: true });
    const timedRow = timed.rows[0]!;
    timedRow.startedAt = new Date(Date.now() - 60_000);
    await mkdir(join(timed.root, 'broadcasts', 'other-recording'), { recursive: true });
    await writeFile(join(timed.root, 'broadcasts', 'other-recording', 'keep.txt'), 'keep');
    await readyPlaylist(timed.root, timedRow.id);
    timed.child.stdin.once('finish', () => timed.child.emit('close', 0));
    await expect(
      timed.service.upload(timedRow.id, 'host', 0, Buffer.from('late')),
    ).rejects.toMatchObject({
      response: { statusCode: 409, error: 'recording_limit', message: RECORDING_TIME_MESSAGE },
    });
    expect(timed.child.stdin.read()).toBeNull();
    expect(timedRow.status).toBe('READY');
    expect(
      await readFile(join(timed.root, 'broadcasts', 'other-recording', 'keep.txt'), 'utf8'),
    ).toBe('keep');

    const guest = await fixture(
      undefined,
      undefined,
      new EncoderBudget(1, 1),
      budget({ guestStorageBytes: 10, maxRecordingBytes: 100, minFreeBytes: 0 }),
      openStorage(async () => ({ recordings: 0, bytes: 8 })),
    );
    expect(await guest.service.start(randomUUID(), 'guest-host', guest.hooks, true)).toEqual({
      ok: true,
    });
    const guestRow = guest.rows[0]!;
    await guest.service.upload(guestRow.id, 'guest-host', 0, Buffer.from('ok'));
    await readyPlaylist(guest.root, guestRow.id);
    guest.child.stdin.once('finish', () => guest.child.emit('close', 0));
    await expect(
      guest.service.upload(guestRow.id, 'guest-host', 1, Buffer.from('x')),
    ).rejects.toMatchObject({
      response: {
        statusCode: 507,
        error: 'storage_full',
        message: failure('storage_full').message,
      },
    });
    expect(guest.child.stdin.read()).toEqual(Buffer.from('ok'));
    expect(guestRow.status).toBe('READY');

    let probes = 0;
    const pressured = await fixture(undefined, undefined, new EncoderBudget(1, 1), undefined, {
      freeBytes: async () => {
        probes += 1;
        return probes >= 3 ? 0 : 1_000_000_000_000;
      },
      storedBytes: async () => 0,
    });
    expect(await pressured.start()).toEqual({ ok: true });
    const pressuredRow = pressured.rows[0]!;
    await pressured.service.upload(pressuredRow.id, 'host', 0, Buffer.from('webm'));
    await mkdir(join(pressured.root, 'broadcasts', 'other-recording'), { recursive: true });
    await writeFile(join(pressured.root, 'broadcasts', 'other-recording', 'keep.txt'), 'keep');
    await readyPlaylist(pressured.root, pressuredRow.id);
    pressured.child.stdin.once('finish', () => pressured.child.emit('close', 0));
    await expect(
      pressured.service.upload(pressuredRow.id, 'host', 1, Buffer.from('nope')),
    ).rejects.toMatchObject({
      response: {
        statusCode: 507,
        error: 'storage_full',
        message: failure('storage_full').message,
      },
    });
    expect(pressured.child.stdin.read()).toEqual(Buffer.from('webm'));
    expect(pressuredRow.status).toBe('READY');
    expect(
      await readFile(join(pressured.root, 'broadcasts', 'other-recording', 'keep.txt'), 'utf8'),
    ).toBe('keep');
    expect(JSON.stringify(failure('storage_full'))).not.toContain(pressured.root);
  } finally {
    logger.mockRestore();
  }
});
