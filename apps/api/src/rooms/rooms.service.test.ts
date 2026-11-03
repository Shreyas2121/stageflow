import 'reflect-metadata';
import { expect, it, vi } from 'vitest';
import { encodeHistoryCursor, parseHistoryCursor } from '@stageflow/shared';
import type { FindOperator, Repository } from 'typeorm';
import { ApiException } from '../http/api.exception';
import type { User } from '../users/user.entity';
import type { Room } from './room.entity';
import { RoomsService } from './rooms.service';

const callerId = '11111111-1111-4111-8111-111111111111';
const otherId = '22222222-2222-4222-8222-222222222222';

function guest(id = callerId): User {
  return {
    id,
    displayName: 'Ava',
    isGuest: true,
    createdAt: new Date('2026-11-03T00:00:00.000Z'),
  } as User;
}

function room(index: number, host: User): Room {
  return {
    id: `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`,
    slug: `RoomSlug${index.toString().padStart(4, '0')}`,
    title: `Room ${index}`,
    mode: 'MEETING',
    status: 'LIVE',
    hostId: host.id,
    host,
    createdAt: new Date(Date.UTC(2026, 10, 3, 15, 4, 5, index)),
    endedAt: null,
  } as Room;
}

function fixture(rows: Room[]) {
  const repository = { find: vi.fn(async () => rows) };
  const service = new RoomsService(repository as unknown as Repository<Room>);
  return { service, repository };
}

it('queries the caller when the query names another host', async () => {
  const host = guest();
  const { service, repository } = fixture([]);
  await expect(
    service.listForHost(host, { hostId: otherId, userId: otherId, displayName: 'Sam' }),
  ).resolves.toEqual({ items: [], nextCursor: null });
  expect(repository.find).toHaveBeenCalledWith({
    where: { hostId: callerId },
    order: { createdAt: 'DESC', id: 'DESC' },
    take: 21,
    relations: { host: true },
  });
});

it('does not query when the limit or the cursor is invalid', async () => {
  const host = guest();
  const { service, repository } = fixture([]);
  await expect(service.listForHost(host, { limit: '020' })).rejects.toEqual(
    expect.any(ApiException),
  );
  await expect(service.listForHost(host, { limit: '0' })).rejects.toMatchObject({
    response: {
      statusCode: 400,
      error: 'invalid_page',
      message: 'Choose a page size from 1 to 50.',
    },
  });
  await expect(service.listForHost(host, { limit: ['20'] })).rejects.toMatchObject({
    response: { statusCode: 400, error: 'invalid_page' },
  });
  await expect(service.listForHost(host, { cursor: 'not-a-cursor' })).rejects.toMatchObject({
    response: {
      statusCode: 400,
      error: 'invalid_cursor',
      message: 'That page cursor is not valid.',
    },
  });
  await expect(service.listForHost(host, { cursor: ['cursor'] })).rejects.toMatchObject({
    response: { statusCode: 400, error: 'invalid_cursor' },
  });
  expect(repository.find).not.toHaveBeenCalled();
});

it('requests one extra row when the limit is missing', async () => {
  const { service, repository } = fixture([]);
  await service.listForHost(guest(), {});
  expect(repository.find).toHaveBeenCalledWith(
    expect.objectContaining({ take: 21, where: { hostId: callerId } }),
  );
});

it('returns 20 rooms and a cursor for the 20th row when another row exists', async () => {
  const host = guest();
  const rows = Array.from({ length: 21 }, (_, index) => room(index, host));
  const { service } = fixture(rows);
  const result = await service.listForHost(host, {});
  const kept = rows[19]!;
  expect(result.items).toHaveLength(20);
  expect(result.items.map((item) => item.id)).toEqual(rows.slice(0, 20).map((item) => item.id));
  expect(result.items[19]).toEqual({
    id: kept.id,
    slug: kept.slug,
    title: kept.title,
    mode: 'MEETING',
    status: 'LIVE',
    hostId: host.id,
    hostDisplayName: 'Ava',
    createdAt: kept.createdAt.toISOString(),
    endedAt: null,
  });
  expect(parseHistoryCursor(result.nextCursor)).toEqual({
    ok: true,
    value: { createdAt: kept.createdAt.toISOString(), id: kept.id },
  });
});

it('returns a null cursor when the page has two rooms', async () => {
  const host = guest();
  const rows = [room(0, host), room(1, host)];
  const { service } = fixture(rows);
  const result = await service.listForHost(host, {});
  expect(result.nextCursor).toBeNull();
  expect(result.items.map((item) => item.id)).toEqual(rows.map((item) => item.id));
});

it('passes the cursor instant and id into the keyset predicate', async () => {
  const createdAt = '2026-11-03T15:04:05.006Z';
  const id = '550e8400-e29b-41d4-a716-446655440000';
  const cursor = encodeHistoryCursor(createdAt, id);
  const { service, repository } = fixture([]);
  await service.listForHost(guest(), { cursor });
  const calls = repository.find.mock.calls as unknown as Array<
    [{ where: { hostId: string; id?: FindOperator<string> } }]
  >;
  const where = calls[0]?.[0].where;
  expect(where?.hostId).toBe(callerId);
  expect(where?.id?.objectLiteralParameters).toEqual({
    cursorCreatedAt: createdAt,
    cursorId: id,
  });
  expect(where?.id?.getSql?.('Room.id')).toBe(
    '("Room"."created_at", "Room"."id") < (CAST(:cursorCreatedAt AS timestamptz), CAST(:cursorId AS uuid))',
  );
});

it('rejects a full page whose next cursor would not parse', async () => {
  const host = guest();
  const rows = Array.from({ length: 21 }, (_, index) => room(index, host));
  rows[19]!.id = 'not-a-uuid';
  const { service } = fixture(rows);
  await expect(service.listForHost(host, {})).rejects.toMatchObject({
    response: { statusCode: 500, error: 'server_busy' },
  });
});
