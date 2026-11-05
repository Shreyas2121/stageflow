import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { type FindOperator, type Repository } from 'typeorm';
import type { User } from '../users/user.entity';
import type { RoomsService } from '../rooms/rooms.service';
import type { Broadcast } from './broadcast.entity';
import { BroadcastsService } from './broadcasts.service';
import * as paths from './hls-path';
import { writeFile } from 'node:fs/promises';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const failure = 'The replay could not be deleted. Try again.';

async function fixture(status: Broadcast['status'] = 'READY') {
  const root = await mkdtemp(join(tmpdir(), 'sf-replay-delete-'));
  roots.push(root);
  const owner = { id: randomUUID(), isGuest: false, email: null, passwordHash: null } as User;
  const room = { id: randomUUID(), hostId: owner.id };
  const id = randomUUID();
  const directory = await paths.prepareBroadcastDirectory(root, id);
  await writeFile(join(directory, 'index.m3u8'), '#EXTM3U');
  const row = {
    id,
    roomId: room.id,
    status,
    visibility: 'LINK',
    playlistPath: `broadcasts/${id}/index.m3u8`,
    thumbnailPath: null,
    errorMessage: null,
    startedAt: new Date(),
    endedAt: new Date(),
    createdAt: new Date(),
  } as Broadcast;
  let stored: Broadcast | null = structuredClone(row);
  type Where = { id: string; status?: Broadcast['status'] | FindOperator<Broadcast['status'][]> };
  const matches = (where: Where) =>
    stored &&
    where.id === stored.id &&
    (where.status === undefined ||
      (typeof where.status === 'string'
        ? stored.status === where.status
        : where.status.value.includes(stored.status)));
  const repository = {
    findOneBy: vi.fn(async ({ id }: { id: string }) =>
      stored?.id === id ? structuredClone(stored) : null,
    ),
    update: vi.fn(async (where: Where, patch: Partial<Broadcast>) => {
      if (!matches(where)) return { affected: 0 };
      Object.assign(stored!, patch);
      return { affected: 1 };
    }),
    delete: vi.fn(async (where: Where) => {
      if (!matches(where)) return { affected: 0 };
      stored = null;
      return { affected: 1 };
    }),
  };
  const rooms = { getById: vi.fn(async () => room) };
  const active = {
    read: vi.fn<(roomId: string) => Promise<string | null>>(async () => null),
    close: vi.fn(async () => {}),
  };
  const service = new BroadcastsService(
    repository as unknown as Repository<Broadcast>,
    rooms as unknown as RoomsService,
    undefined,
    root,
    undefined,
    active,
  );
  vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
  return {
    root,
    row,
    owner,
    room,
    directory,
    repository,
    rooms,
    active,
    service,
    stored: () => stored,
  };
}

it.each(['READY', 'FAILED'] as const)(
  'changes only visibility on %s, ignores extra body fields, and does not write the current value',
  async (status) => {
    const f = await fixture(status);
    const before = structuredClone(f.stored());
    expect(await f.service.setVisibility(f.row.id, f.owner, { visibility: 'LINK' })).toMatchObject({
      visibility: 'LINK',
    });
    expect(f.repository.update).not.toHaveBeenCalled();
    for (const visibility of ['HOST', 'LINK']) {
      expect(
        await f.service.setVisibility(f.row.id, f.owner, {
          visibility,
          status: 'LIVE',
          playlistPath: 'ignored',
        }),
      ).toMatchObject({ visibility });
      expect(f.stored()).toEqual({ ...before, visibility });
      expect(f.repository.update).toHaveBeenLastCalledWith(
        expect.objectContaining({ id: f.row.id }),
        { visibility },
      );
    }
  },
);

it.each(['STARTING', 'LIVE', 'STOPPING'] as const)(
  'refuses visibility changes and deletion for %s without reading Redis or writing',
  async (status) => {
    const f = await fixture(status);
    await expect(
      f.service.setVisibility(f.row.id, f.owner, { visibility: 'HOST' }),
    ).rejects.toMatchObject({
      response: {
        statusCode: 409,
        error: 'broadcast_not_ready',
        message: 'Hide a replay after it has finished.',
      },
    });
    await expect(f.service.deleteReplay(f.row.id, f.owner)).rejects.toMatchObject({
      response: {
        statusCode: 409,
        error: 'broadcast_not_deletable',
        message: 'A live broadcast cannot be deleted.',
      },
    });
    expect(f.active.read).not.toHaveBeenCalled();
    expect(f.repository.update).not.toHaveBeenCalled();
    expect(await readFile(join(f.directory, 'index.m3u8'), 'utf8')).toBe('#EXTM3U');
  },
);

it('rejects invalid visibility and guest/foreign owners before mutations', async () => {
  const f = await fixture();
  for (const body of [null, {}, { visibility: 'host' }])
    await expect(f.service.setVisibility(f.row.id, f.owner, body)).rejects.toMatchObject({
      response: { statusCode: 400, error: 'invalid_visibility' },
    });
  for (const user of [
    { ...f.owner, isGuest: true },
    { ...f.owner, id: randomUUID() },
  ]) {
    for (const mutate of [
      () => f.service.setVisibility(f.row.id, user, { visibility: 'HOST' }),
      () => f.service.deleteReplay(f.row.id, user),
    ])
      await expect(mutate()).rejects.toMatchObject({
        response:
          user.id === f.owner.id
            ? {
                statusCode: 403,
                error: 'replay_owner_required',
                message: 'Create a host account before changing this replay.',
              }
            : { statusCode: 404, error: 'broadcast_not_found' },
      });
  }
  for (const id of ['invalid', randomUUID()])
    await expect(f.service.deleteReplay(id, f.owner)).rejects.toMatchObject({
      response: { error: 'broadcast_not_found' },
    });
  expect(f.repository.update).not.toHaveBeenCalled();
  expect(f.active.read).not.toHaveBeenCalled();
});

it.each(['READY', 'FAILED'] as const)(
  'claims and deletes a finished %s row and only its directory',
  async (status) => {
    const f = await fixture(status);
    f.active.read.mockResolvedValue(randomUUID());
    expect(await f.service.snapshot(f.room.id, f.row.id)).toMatchObject({ status });
    const sibling = await paths.prepareBroadcastDirectory(f.root, randomUUID());
    await writeFile(join(sibling, 'index.m3u8'), 'keep');
    const remove = vi.spyOn(paths, 'removeBroadcastDirectory');
    const deleted = f.repository.delete.getMockImplementation()!;
    f.repository.delete.mockImplementation(async (where) => {
      expect(f.stored()?.status).toBe('DELETING');
      expect(await f.service.snapshot(f.room.id, f.row.id)).toBeNull();
      await expect(
        f.service.setVisibility(f.row.id, f.owner, { visibility: 'LINK' }),
      ).rejects.toMatchObject({ response: { error: 'broadcast_not_found' } });
      expect(remove).toHaveBeenCalledOnce();
      await expect(readFile(join(f.directory, 'index.m3u8'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      return deleted(where);
    });
    await f.service.deleteReplay(f.row.id, f.owner);
    expect(f.active.read).toHaveBeenCalledWith(f.room.id);
    expect(f.repository.update).toHaveBeenCalledWith(
      { id: f.row.id, status },
      { status: 'DELETING' },
    );
    expect(f.stored()).toBeNull();
    expect(await readFile(join(sibling, 'index.m3u8'), 'utf8')).toBe('keep');
    expect(f.rooms.getById).toHaveBeenCalledWith(f.room.id);
  },
);

it('refuses the active Redis id and fails a Redis read before claiming', async () => {
  const f = await fixture();
  f.active.read.mockResolvedValueOnce(f.row.id).mockRejectedValueOnce(new Error('Redis down'));
  await expect(f.service.deleteReplay(f.row.id, f.owner)).rejects.toMatchObject({
    response: { statusCode: 409, error: 'broadcast_not_deletable' },
  });
  await expect(f.service.deleteReplay(f.row.id, f.owner)).rejects.toMatchObject({
    response: { statusCode: 500, error: 'broadcast_delete_failed', message: failure },
  });
  expect(f.repository.update).not.toHaveBeenCalled();
  expect(f.stored()?.status).toBe('READY');
  expect(await readFile(join(f.directory, 'index.m3u8'), 'utf8')).toBe('#EXTM3U');
});

it('restores READY on removal failure and allows the owner to retry', async () => {
  const f = await fixture();
  const remove = vi
    .spyOn(paths, 'removeBroadcastDirectory')
    .mockRejectedValueOnce(new Error('locked'));
  await expect(f.service.deleteReplay(f.row.id, f.owner)).rejects.toMatchObject({
    response: { error: 'broadcast_delete_failed', message: failure },
  });
  expect(f.repository.update).toHaveBeenLastCalledWith(
    { id: f.row.id, status: 'DELETING' },
    { status: 'READY', errorMessage: failure },
  );
  expect(f.stored()).toMatchObject({
    status: 'READY',
    errorMessage: failure,
    playlistPath: f.row.playlistPath,
  });
  expect(await readFile(join(f.directory, 'index.m3u8'), 'utf8')).toBe('#EXTM3U');
  remove.mockRestore();
  await f.service.deleteReplay(f.row.id, f.owner);
  expect(f.stored()).toBeNull();
});

it.each(['READY', 'DELETING'] as const)(
  'removes a %s row when its directory is already absent',
  async (status) => {
    const f = await fixture(status);
    await rm(f.directory, { recursive: true });
    await f.service.deleteReplay(f.row.id, f.owner);
    expect(f.stored()).toBeNull();
    if (status === 'DELETING') expect(f.repository.update).not.toHaveBeenCalled();
  },
);

it('keeps an escaping junction and its target intact and restores the row', async () => {
  const f = await fixture();
  const outsideRoot = await mkdtemp(join(tmpdir(), 'sf-replay-outside-'));
  roots.push(outsideRoot);
  const other = await paths.prepareBroadcastDirectory(outsideRoot, randomUUID());
  await writeFile(join(other, 'index.m3u8'), 'keep');
  await rm(f.directory, { recursive: true });
  await symlink(other, f.directory, 'junction');
  await expect(f.service.deleteReplay(f.row.id, f.owner)).rejects.toMatchObject({
    response: { error: 'broadcast_delete_failed' },
  });
  expect(f.stored()?.status).toBe('READY');
  expect(await readFile(join(f.directory, 'index.m3u8'), 'utf8')).toBe('keep');
  expect(await readFile(join(other, 'index.m3u8'), 'utf8')).toBe('keep');
});

it('does not remove files after a lost claim and does not restore a changed row', async () => {
  const f = await fixture();
  f.repository.update.mockResolvedValueOnce({ affected: 0 });
  await expect(f.service.deleteReplay(f.row.id, f.owner)).rejects.toMatchObject({
    response: { error: 'broadcast_not_found' },
  });
  expect(await readFile(join(f.directory, 'index.m3u8'), 'utf8')).toBe('#EXTM3U');
  vi.spyOn(paths, 'removeBroadcastDirectory').mockImplementationOnce(async () => {
    await f.repository.update({ id: f.row.id }, { status: 'FAILED' });
    throw new Error('concurrent recovery');
  });
  await expect(f.service.deleteReplay(f.row.id, f.owner)).rejects.toMatchObject({
    response: { error: 'broadcast_delete_failed' },
  });
  expect(f.stored()?.status).toBe('FAILED');
});

it('keeps a failed row deletion retryable and closes its active reader on shutdown', async () => {
  const f = await fixture();
  f.repository.delete.mockRejectedValueOnce(new Error('database down'));
  await expect(f.service.deleteReplay(f.row.id, f.owner)).rejects.toMatchObject({
    response: { error: 'broadcast_delete_failed' },
  });
  expect(f.stored()?.status).toBe('READY');
  await f.service.deleteReplay(f.row.id, f.owner);
  expect(f.stored()).toBeNull();
  await f.service.onModuleDestroy();
  expect(f.active.close).toHaveBeenCalledOnce();
});

it('fails a second delete closed while the first is removing files', async () => {
  const f = await fixture();
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = paths.removeBroadcastDirectory;
  vi.spyOn(paths, 'removeBroadcastDirectory').mockImplementationOnce(async (...args) => {
    entered();
    await gate;
    return original(...args);
  });
  const first = f.service.deleteReplay(f.row.id, f.owner);
  await started;
  try {
    await expect(f.service.deleteReplay(f.row.id, f.owner)).rejects.toMatchObject({
      response: { error: 'broadcast_not_found' },
    });
    expect(await readFile(join(f.directory, 'index.m3u8'), 'utf8')).toBe('#EXTM3U');
  } finally {
    release();
    await first;
  }
  expect(f.stored()).toBeNull();
});

it('lets the owner retry an interrupted DELETING claim with remaining files', async () => {
  const f = await fixture('DELETING');
  await f.service.deleteReplay(f.row.id, f.owner);
  expect(f.stored()).toBeNull();
  await expect(readFile(join(f.directory, 'index.m3u8'))).rejects.toMatchObject({ code: 'ENOENT' });
});
