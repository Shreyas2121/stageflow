import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { type FindOperator, type Repository } from 'typeorm';
import {
  encodeHistoryCursor,
  parseBroadcast,
  parseHistoryCursor,
  type BroadcastStatus,
} from '@stageflow/shared';
import type { RoomsService } from '../rooms/rooms.service';
import { ApiException } from '../http/api.exception';
import { LiveConnection, type LiveRedisClient } from '../live/live.connection';
import type { Broadcast } from './broadcast.entity';
import { BroadcastsService } from './broadcasts.service';

function row(status: BroadcastStatus, roomId = randomUUID()): Broadcast {
  return {
    id: randomUUID(),
    roomId,
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
  const rows = (['STARTING', 'LIVE', 'STOPPING', 'READY', 'FAILED'] as const).map((status) =>
    row(status),
  );
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
  const rows = (['STARTING', 'LIVE', 'STOPPING', 'READY', 'FAILED'] as const).map((status) =>
    row(status),
  );
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
  const roomId = randomUUID();
  const rows = (['STARTING', 'LIVE', 'STOPPING', 'READY', 'FAILED'] as const).map((status) =>
    row(status, roomId),
  );
  const ready = rows[3]!;
  const failed = rows[4]!;
  ready.thumbnailPath = `broadcasts/${ready.id}/thumbnail.jpg`;
  failed.thumbnailPath = 'broadcasts/other/thumbnail.jpg';
  const { service, repository, rooms } = fixture(rows);
  const result = await service.listByRoomSlug('abc123abc123', {});
  expect(rooms.getBySlug).toHaveBeenCalledWith('abc123abc123');
  expect(repository.find).toHaveBeenCalledWith({
    where: { roomId },
    order: { createdAt: 'DESC', id: 'DESC' },
    take: 21,
  });
  expect(result.nextCursor).toBeNull();
  expect(result.items.map((item) => item.status)).toEqual([
    'STARTING',
    'LIVE',
    'STOPPING',
    'READY',
    'FAILED',
  ]);
  expect(result.items.map((item) => item.thumbnailUrl)).toEqual([
    null,
    null,
    null,
    `/api/broadcasts/${ready.id}/thumbnail.jpg`,
    null,
  ]);
  expect(result.items[3]).toEqual({
    id: ready.id,
    roomId,
    status: 'READY',
    playlistUrl: `/api/broadcasts/${ready.id}/hls/index.m3u8`,
    thumbnailUrl: `/api/broadcasts/${ready.id}/thumbnail.jpg`,
    errorMessage: null,
    startedAt: ready.startedAt.toISOString(),
    endedAt: ready.endedAt?.toISOString() ?? null,
    createdAt: ready.createdAt.toISOString(),
  });
  expect(result.items[0]).toMatchObject({
    playlistUrl: null,
    thumbnailUrl: null,
    errorMessage: null,
  });
  expect(result.items[4]).toMatchObject({
    playlistUrl: null,
    thumbnailUrl: null,
    errorMessage: 'original error',
  });
  for (const item of result.items) {
    expect(item).not.toHaveProperty('playlistPath');
    expect(item).not.toHaveProperty('thumbnailPath');
    expect(parseBroadcast(item)).toEqual(item);
  }
  expect(JSON.stringify(result)).not.toContain('broadcasts/ready');
  expect(JSON.stringify(result)).not.toContain('broadcasts/other');
});

it('does not query broadcasts when the page is invalid', async () => {
  const { service, repository, rooms } = fixture([]);
  await expect(service.listByRoomSlug('abc123abc123', { limit: '020' })).rejects.toMatchObject({
    response: { statusCode: 400, error: 'invalid_page' },
  });
  await expect(
    service.listByRoomSlug('abc123abc123', { cursor: 'not-a-cursor' }),
  ).rejects.toMatchObject({
    response: { statusCode: 400, error: 'invalid_cursor' },
  });
  expect(repository.find).not.toHaveBeenCalled();
  expect(rooms.getBySlug).not.toHaveBeenCalled();
});

it('returns 20 broadcasts and a cursor when another row exists', async () => {
  const roomId = randomUUID();
  const rows = Array.from({ length: 21 }, () => row('FAILED', roomId));
  const { service } = fixture(rows);
  const result = await service.listByRoomSlug('abc123abc123', {});
  const kept = rows[19]!;
  expect(result.items).toHaveLength(20);
  expect(result.items.map((item) => item.id)).toEqual(rows.slice(0, 20).map((item) => item.id));
  expect(parseHistoryCursor(result.nextCursor)).toEqual({
    ok: true,
    value: { createdAt: kept.createdAt.toISOString(), id: kept.id },
  });
});

it('passes the cursor instant and id into the broadcast keyset predicate', async () => {
  const createdAt = '2026-11-03T15:04:05.006Z';
  const id = '550e8400-e29b-41d4-a716-446655440000';
  const roomId = randomUUID();
  const cursor = encodeHistoryCursor(createdAt, id);
  const { service, repository, rooms } = fixture([]);
  rooms.getBySlug.mockResolvedValueOnce({ id: roomId });
  const result = await service.listByRoomSlug('abc123abc123', { cursor, hostId: randomUUID() });
  expect(result).toEqual({ items: [], nextCursor: null });
  const calls = repository.find.mock.calls as unknown as Array<
    [{ where: { roomId: string; id?: FindOperator<string> } }]
  >;
  const where = calls[0]?.[0].where;
  expect(where?.roomId).toBe(roomId);
  expect(where).not.toHaveProperty('hostId');
  expect(where?.id?.objectLiteralParameters).toEqual({
    cursorCreatedAt: createdAt,
    cursorId: id,
  });
  expect(where?.id?.getSql?.('Broadcast.id')).toBe(
    '("Broadcast"."created_at", "Broadcast"."id") < (CAST(:cursorCreatedAt AS timestamptz), CAST(:cursorId AS uuid))',
  );
});

it('rejects a full broadcast page whose next cursor would not parse', async () => {
  const roomId = randomUUID();
  const rows = Array.from({ length: 21 }, () => row('READY', roomId));
  rows[19]!.id = 'not-a-uuid';
  const { service } = fixture(rows);
  await expect(service.listByRoomSlug('abc123abc123', {})).rejects.toMatchObject({
    response: { statusCode: 500, error: 'server_busy' },
  });
});

it('refuses a thumbnail unless the stored path is the catalog file', async () => {
  const ready = row('READY');
  const { service, repository } = fixture([ready]);
  await expect(service.thumbnailFile(ready.id)).rejects.toMatchObject({
    response: { statusCode: 404, error: 'media_not_found' },
  });
  ready.thumbnailPath = 'broadcasts/other/thumbnail.jpg';
  await expect(service.thumbnailFile(ready.id)).rejects.toMatchObject({
    response: { statusCode: 404, error: 'media_not_found' },
  });
  repository.findOneBy.mockClear();
  await expect(service.thumbnailFile('invalid')).rejects.toMatchObject({
    response: { statusCode: 404, error: 'media_not_found' },
  });
  expect(repository.findOneBy).not.toHaveBeenCalled();
  ready.thumbnailPath = `broadcasts/${ready.id}/thumbnail.jpg`;
  await expect(service.thumbnailFile(ready.id)).rejects.toMatchObject({
    response: { statusCode: 404, error: 'media_not_found' },
  });
});

it('returns one broadcast and rejects malformed or unknown ids and unknown rooms', async () => {
  const live = row('LIVE');
  const { service, repository, rooms } = fixture([live]);
  const liveCatalog = await service.getById(live.id);
  expect(liveCatalog).toEqual({
    id: live.id,
    roomId: live.roomId,
    status: 'LIVE',
    playlistUrl: null,
    thumbnailUrl: null,
    errorMessage: null,
    startedAt: live.startedAt.toISOString(),
    endedAt: null,
    createdAt: live.createdAt.toISOString(),
  });
  expect(parseBroadcast(liveCatalog)).toEqual(liveCatalog);
  expect(liveCatalog).not.toHaveProperty('playlistPath');
  repository.findOneBy.mockClear();
  await expect(service.getById('invalid')).rejects.toMatchObject({ response: { statusCode: 404 } });
  expect(repository.findOneBy).not.toHaveBeenCalled();
  await expect(service.getById(randomUUID())).rejects.toMatchObject({
    response: { statusCode: 404 },
  });
  rooms.getBySlug.mockRejectedValueOnce(new ApiException(404, 'room_not_found', 'Missing room'));
  await expect(service.listByRoomSlug('missing', {})).rejects.toMatchObject({
    response: { statusCode: 404 },
  });
  expect(repository.find).not.toHaveBeenCalled();
});
