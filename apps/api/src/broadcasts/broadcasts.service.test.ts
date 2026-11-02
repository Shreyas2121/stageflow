import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { type FindOperator, type Repository } from 'typeorm';
import type { BroadcastStatus } from '@stageflow/shared';
import type { RoomsService } from '../rooms/rooms.service';
import { ApiException } from '../http/api.exception';
import { LiveConnection, type LiveRedisClient } from '../live/live.connection';
import type { Broadcast } from './broadcast.entity';
import { BroadcastsService } from './broadcasts.service';

function row(status: BroadcastStatus): Broadcast {
  return {
    id: randomUUID(),
    roomId: randomUUID(),
    status,
    playlistPath: status === 'READY' ? 'broadcasts/ready/index.m3u8' : null,
    thumbnailPath: null,
    errorMessage: status === 'FAILED' ? 'original error' : null,
    startedAt: new Date('2026-11-02T00:00:00Z'),
    createdAt: new Date('2026-11-02T00:00:00Z'),
    endedAt: status === 'READY' || status === 'FAILED' ? new Date('2026-11-02T00:01:00Z') : null,
  } as Broadcast;
}

function fixture(rows: Broadcast[] = []) {
  const repository = {
    update: vi.fn(
      async (
        where: { status: FindOperator<BroadcastStatus[]> },
        patch: Pick<Broadcast, 'status' | 'errorMessage' | 'endedAt'>,
      ) => {
        for (const row of rows) {
          if (where.status.value.includes(row.status)) Object.assign(row, patch);
        }
      },
    ),
    find: vi.fn(async () => rows),
    findOneBy: vi.fn(async ({ id }: { id: string }) => rows.find((row) => row.id === id) ?? null),
  };
  const rooms = { getBySlug: vi.fn(async () => ({ id: rows[0]?.roomId ?? randomUUID() })) };
  const service = new BroadcastsService(
    repository as unknown as Repository<Broadcast>,
    rooms as unknown as RoomsService,
  );
  return { service, repository, rooms };
}

it('fails only in-flight broadcasts during owning startup and preserves completed rows', async () => {
  const rows = (['STARTING', 'LIVE', 'STOPPING', 'READY', 'FAILED'] as const).map(row);
  const completed = structuredClone(rows.slice(3));
  const { service, repository, rooms } = fixture(rows);
  const deleted = vi.fn(async () => 1);
  const scan = vi.fn(async (): Promise<[string, string[]]> => {
    expect(repository.update).toHaveBeenCalledOnce();
    expect(rows.slice(0, 3).every((row) => row.status === 'FAILED')).toBe(true);
    return ['0', ['test:room:one:broadcast']];
  });
  const redis = {
    status: 'ready',
    connect: async () => {},
    ping: async () => 'PONG',
    set: async () => 'OK',
    scan,
    del: deleted,
    on: () => {},
    disconnect: () => {},
  } as unknown as LiveRedisClient;
  const connection = new LiveConnection(redis, 'test', () => service.failInFlight());
  await connection.open();
  expect(connection.isReady()).toBe(true);
  for (const row of rows.slice(0, 3)) {
    expect(row.status).toBe('FAILED');
    expect(row.errorMessage).toBe('api restarted');
    expect(row.endedAt).toBeInstanceOf(Date);
  }
  expect(rows.slice(3)).toEqual(completed);
  expect(rooms.getBySlug).not.toHaveBeenCalled();
  expect(deleted).toHaveBeenCalledExactlyOnceWith('test:room:one:broadcast');
  expect(scan).toHaveBeenCalledWith('0', 'MATCH', 'test:room:*', 'COUNT', 100);
});

it('leaves every row and live key intact when another API owns the namespace', async () => {
  const rows = (['STARTING', 'LIVE', 'STOPPING', 'READY', 'FAILED'] as const).map(row);
  const before = structuredClone(rows);
  const { service, repository } = fixture(rows);
  const scan = vi.fn();
  const del = vi.fn();
  const redis = {
    connect: async () => {},
    ping: async () => 'PONG',
    set: async () => null,
    scan,
    del,
    on: () => {},
    disconnect: () => {},
  } as unknown as LiveRedisClient;
  const connection = new LiveConnection(redis, 'test', () => service.failInFlight());
  await expect(connection.open()).rejects.toThrow('already has an API owner');
  expect(repository.update).not.toHaveBeenCalled();
  expect(scan).not.toHaveBeenCalled();
  expect(del).not.toHaveBeenCalled();
  expect(rows).toEqual(before);
});

it('lists only the requested room, newest first, and returns serialized catalog fields', async () => {
  const ready = row('READY');
  const { service, repository, rooms } = fixture([ready]);
  const result = await service.listByRoomSlug('abc123abc123');
  expect(rooms.getBySlug).toHaveBeenCalledWith('abc123abc123');
  expect(repository.find).toHaveBeenCalledWith({
    where: { roomId: ready.roomId },
    order: { createdAt: 'DESC', id: 'DESC' },
  });
  expect(result).toEqual([
    {
      ...ready,
      startedAt: ready.startedAt.toISOString(),
      endedAt: ready.endedAt?.toISOString(),
      createdAt: ready.createdAt.toISOString(),
    },
  ]);
});

it('returns one broadcast and rejects malformed or unknown ids and unknown rooms', async () => {
  const live = row('LIVE');
  const { service, repository, rooms } = fixture([live]);
  expect(await service.getById(live.id)).toMatchObject({
    id: live.id,
    status: 'LIVE',
    endedAt: null,
  });
  repository.findOneBy.mockClear();
  await expect(service.getById('invalid')).rejects.toMatchObject({ response: { statusCode: 404 } });
  expect(repository.findOneBy).not.toHaveBeenCalled();
  await expect(service.getById(randomUUID())).rejects.toMatchObject({
    response: { statusCode: 404 },
  });
  rooms.getBySlug.mockRejectedValueOnce(new ApiException(404, 'room_not_found', 'Missing room'));
  await expect(service.listByRoomSlug('missing')).rejects.toMatchObject({
    response: { statusCode: 404 },
  });
  expect(repository.find).not.toHaveBeenCalled();
});
