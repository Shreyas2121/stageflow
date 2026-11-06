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
    scheduledStartAt: null,
    requireAdmission: false,
    hostId: host.id,
    host,
    createdAt: new Date(Date.UTC(2026, 10, 3, 15, 4, 5, index)),
    endedAt: null,
  } as Room;
}

function orderingInstant(date: Date): string {
  return date.toISOString().replace(/\.(\d{3})Z$/, '.$1000Z');
}

function fixture(rows: Room[]) {
  const repository = {
    find: vi.fn(async () => rows),
    query: vi.fn(async (_sql: string, parameters: unknown[]) => {
      const found = rows.find((row) => row.id === parameters[0]);
      return found ? [{ ordering: orderingInstant(found.createdAt) }] : [];
    }),
  };
  const service = new RoomsService(repository as unknown as Repository<Room>);
  return { service, repository };
}

it.each([true, false])(
  'creates an immediate room with defaults for isGuest=%s',
  async (isGuest) => {
    const host = { ...guest(), isGuest };
    const repository = {
      create: vi.fn((fields: Partial<Room>) => ({ ...room(1, host), ...fields })),
      insert: vi.fn(async () => undefined),
    };
    const service = new RoomsService(repository as unknown as Repository<Room>);
    const response = await service.create(host, { title: 'Design review', mode: 'MEETING' });
    expect(repository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Design review',
        mode: 'MEETING',
        status: 'LIVE',
        scheduledStartAt: null,
        requireAdmission: false,
      }),
    );
    expect(repository.insert).toHaveBeenCalledOnce();
    expect(response).toMatchObject({
      status: 'LIVE',
      scheduledStartAt: null,
      requireAdmission: false,
    });
  },
);

it.each(['MEETING', 'WEBINAR'] as const)(
  'lets a Google-only host schedule a past %s',
  async (mode) => {
    const host = {
      ...guest(),
      isGuest: false,
      email: null,
      passwordHash: null,
      googleSubject: 'google-only',
    };
    const repository = {
      create: vi.fn((fields: Partial<Room>) => ({ ...room(1, host), ...fields })),
      insert: vi.fn(async () => undefined),
      update: vi.fn(),
    };
    const service = new RoomsService(repository as unknown as Repository<Room>);
    expect(
      await service.create(host, {
        title: 'Scheduled review',
        mode,
        status: 'SCHEDULED',
        scheduledStartAt: '2000-01-01T00:00:00.123Z',
        requireAdmission: mode === 'MEETING',
        hostId: otherId,
      }),
    ).toMatchObject({
      hostId: host.id,
      status: 'SCHEDULED',
      scheduledStartAt: '2000-01-01T00:00:00.123Z',
      requireAdmission: mode === 'MEETING',
    });
    expect(repository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        hostId: host.id,
        status: 'SCHEDULED',
        scheduledStartAt: new Date('2000-01-01T00:00:00.123Z'),
      }),
    );
    expect(repository.insert).toHaveBeenCalledOnce();
    expect(repository.update).not.toHaveBeenCalled();
  },
);

it.each([
  { isGuest: true, fields: { status: 'LIVE' }, statusCode: 403, error: 'schedule_not_allowed' },
  {
    isGuest: true,
    fields: { scheduledStartAt: '2000-01-01T00:00:00.000Z' },
    statusCode: 403,
    error: 'schedule_not_allowed',
  },
  {
    isGuest: true,
    fields: { requireAdmission: false },
    statusCode: 403,
    error: 'schedule_not_allowed',
  },
  {
    isGuest: false,
    fields: { mode: 'WEBINAR', requireAdmission: true },
    statusCode: 400,
    error: 'invalid_admission',
  },
  {
    isGuest: false,
    fields: { scheduledStartAt: '2000-01-01T00:00:00.000Z' },
    statusCode: 400,
    error: 'invalid_schedule',
  },
  { isGuest: false, fields: { status: 'SCHEDULED' }, statusCode: 400, error: 'invalid_schedule' },
])('rejects invalid create before writing: %j', async ({ isGuest, fields, statusCode, error }) => {
  const repository = { create: vi.fn(), insert: vi.fn() };
  const service = new RoomsService(repository as unknown as Repository<Room>);
  await expect(
    service.create({ ...guest(), isGuest }, { title: 'Review', mode: 'MEETING', ...fields }),
  ).rejects.toMatchObject({ response: { statusCode, error } });
  expect(repository.create).not.toHaveBeenCalled();
  expect(repository.insert).not.toHaveBeenCalled();
});

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
  expect(repository.query).not.toHaveBeenCalled();
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
    scheduledStartAt: null,
    requireAdmission: false,
    hostId: host.id,
    hostDisplayName: 'Ava',
    createdAt: kept.createdAt.toISOString(),
    endedAt: null,
  });
  expect(parseHistoryCursor(result.nextCursor)).toEqual({
    ok: true,
    value: { createdAt: orderingInstant(kept.createdAt), id: kept.id },
  });
  expect(result.items[19]?.createdAt).toBe(kept.createdAt.toISOString());
});

it('returns a null cursor when the page has two rooms', async () => {
  const host = guest();
  const rows = [room(0, host), room(1, host)];
  const { service, repository } = fixture(rows);
  const result = await service.listForHost(host, {});
  expect(result.nextCursor).toBeNull();
  expect(result.items.map((item) => item.id)).toEqual(rows.map((item) => item.id));
  expect(repository.query).not.toHaveBeenCalled();
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

  const ordering = '2026-11-03T15:04:05.123900Z';
  const precise = encodeHistoryCursor(ordering, id);
  await service.listForHost(guest(), { cursor: precise });
  const preciseWhere = (
    repository.find.mock.calls as unknown as Array<[{ where: { id?: FindOperator<string> } }]>
  )[1]?.[0].where;
  expect(preciseWhere?.id?.objectLiteralParameters).toEqual({
    cursorCreatedAt: ordering,
    cursorId: id,
  });
});

it('refuses the page when the ordering instant cannot be read', async () => {
  const host = guest();
  const rows = Array.from({ length: 21 }, (_, index) => room(index, host));
  const repository = {
    find: vi.fn(async () => rows),
    query: vi.fn(async () => []),
  };
  const service = new RoomsService(repository as unknown as Repository<Room>);
  await expect(service.listForHost(host, {})).rejects.toMatchObject({
    response: { statusCode: 500, error: 'server_busy' },
  });
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
