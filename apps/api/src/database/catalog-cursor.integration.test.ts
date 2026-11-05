import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareBroadcastDirectory } from '../broadcasts/hls-path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { DataSource, type DataSourceOptions } from 'typeorm';
import { encodeHistoryCursor, parseBroadcast, parseHistoryCursor } from '@stageflow/shared';
import { databaseOptions } from './data-source';
import { BroadcastsService } from '../broadcasts/broadcasts.service';
import { Broadcast } from '../broadcasts/broadcast.entity';
import { RoomsService } from '../rooms/rooms.service';
import { Room } from '../rooms/room.entity';
import type { User } from '../users/user.entity';

const adminUrl = process.env.DATABASE_URL;
if (!adminUrl) throw new Error('DATABASE_URL is required.');
const databaseName = `sf_cursor_${randomUUID().replaceAll('-', '')}`;
const databaseUrl = new URL(adminUrl);
databaseUrl.pathname = `/${databaseName}`;

const hostId = randomUUID();
const otherHostId = randomUUID();
const castHostId = randomUUID();
const roomId = randomUUID();
const otherRoomId = randomUUID();
const instants = [
  '2026-11-04T12:00:00.123900Z',
  '2026-11-04T12:00:00.123800Z',
  '2026-11-04T12:00:00.123000Z',
  '2026-11-04T12:00:00.122900Z',
  '2026-11-04T12:00:00.122000Z',
  '2026-11-04T12:00:00.122000Z',
];

function postgresOptions(): Extract<DataSourceOptions, { type: 'postgres' }> {
  if (databaseOptions.type !== 'postgres') throw new Error('Expected the PostgreSQL data source.');
  return databaseOptions;
}
let created = false;
let admin: DataSource | undefined;
let dataSource: DataSource | undefined;
let rooms: RoomsService | undefined;
let broadcasts: BroadcastsService | undefined;
let roomOrder: Array<{ id: string; ordering: string }> = [];
let broadcastOrder: Array<{ id: string; ordering: string }> = [];

function caller(id: string): User {
  return { id } as User;
}

async function insertInstant(
  table: 'rooms' | 'broadcasts',
  id: string,
  instant: string,
  ownerId: string,
  slug?: string,
): Promise<void> {
  if (!dataSource) throw new Error('Database is not open.');
  if (table === 'rooms') {
    await dataSource.query(
      `INSERT INTO rooms (id, slug, title, mode, status, host_id, created_at)
       VALUES ($1, $2, $3, 'MEETING', 'LIVE', $4, $5::timestamptz)`,
      [id, slug, `Room ${slug}`, ownerId, instant],
    );
    return;
  }
  await dataSource.query(
    `INSERT INTO broadcasts (id, room_id, status, started_at, created_at)
     VALUES ($1, $2, 'READY', $3::timestamptz, $3::timestamptz)`,
    [id, ownerId, instant],
  );
}

async function ordered(table: 'rooms' | 'broadcasts', column: string, ownerId: string) {
  if (!dataSource) throw new Error('Database is not open.');
  const rows: unknown = await dataSource.query(
    `SELECT id::text AS id,
            to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ordering
     FROM ${table}
     WHERE ${column} = $1
     ORDER BY created_at DESC, id DESC`,
    [ownerId],
  );
  if (!Array.isArray(rows)) throw new Error('Expected ordering rows.');
  return rows.map((row: { id: string; ordering: string }) => ({
    id: row.id,
    ordering: row.ordering,
  }));
}

beforeAll(async () => {
  if (!/^sf_cursor_[a-f0-9]{32}$/.test(databaseName)) throw new Error('Unexpected database name.');
  admin = new DataSource({
    type: 'postgres',
    url: adminUrl,
    extra: { connectionTimeoutMillis: 3000, statement_timeout: 5000, query_timeout: 6000 },
  });
  await admin.initialize();
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  created = true;
  dataSource = new DataSource({
    ...postgresOptions(),
    url: databaseUrl.href,
    extra: { connectionTimeoutMillis: 3000, statement_timeout: 5000, query_timeout: 6000 },
  });
  await dataSource.initialize();
  const source = dataSource;
  const applied = await source.runMigrations();
  expect(applied.map((migration) => migration.name)).toEqual([
    'CreateUsersAndRooms1730332800000',
    'CreateBroadcasts1793577600000',
    'IndexRoomsByHost1793664000000',
    'AddHostCredentials1793923200000',
    'AddGoogleSubject1794009600000',
    'AddBroadcastVisibility1794096000000',
    'AddRoomSchedule1794182400000',
  ]);
  expect(await source.runMigrations()).toEqual([]);
  await source.query(
    `INSERT INTO users (id, display_name, is_guest, created_at) VALUES
       ($1, 'Ava', true, '2026-11-04T00:00:00Z'),
       ($2, 'Sam', true, '2026-11-04T00:00:00Z'),
       ($3, 'Ned', true, '2026-11-04T00:00:00Z')`,
    [hostId, otherHostId, castHostId],
  );
  let slug = 0;
  for (const instant of instants) {
    slug += 1;
    await insertInstant(
      'rooms',
      randomUUID(),
      instant,
      hostId,
      `CursorRoom${String(slug).padStart(2, '0')}`,
    );
  }
  await insertInstant(
    'rooms',
    otherRoomId,
    '2026-11-04T12:00:00.123850Z',
    otherHostId,
    'CursorOther1',
  );
  await dataSource.query(
    `INSERT INTO rooms (id, slug, title, mode, status, host_id, created_at)
     VALUES ($1, 'CursorCast01', 'Cast', 'WEBINAR', 'LIVE', $2, '2026-11-04T11:00:00Z')`,
    [roomId, castHostId],
  );
  for (const instant of instants) await insertInstant('broadcasts', randomUUID(), instant, roomId);
  await insertInstant('broadcasts', randomUUID(), '2026-11-04T12:00:00.123850Z', otherRoomId);
  roomOrder = await ordered('rooms', 'host_id', hostId);
  broadcastOrder = await ordered('broadcasts', 'room_id', roomId);
  rooms = new RoomsService(source.getRepository(Room));
  broadcasts = new BroadcastsService(source.getRepository(Broadcast), rooms);
}, 30_000);

it('filters replay visibility and delete claims in PostgreSQL before paging', async () => {
  if (!dataSource || !broadcasts) throw new Error('Catalog services were not created.');
  const source = dataSource;
  const service = broadcasts;
  const privateRoomId = randomUUID();
  const slug = 'PrivateCast1';
  await insertInstant('rooms', privateRoomId, instants[0]!, castHostId, slug);
  const records: Array<{ id: string; visibility: 'LINK' | 'HOST'; status: 'READY' | 'DELETING' }> =
    [];
  for (let index = 0; index < instants.length; index++) {
    const id = randomUUID();
    const visibility = index % 2 ? 'LINK' : 'HOST';
    const status = index === 0 || index === 3 ? 'DELETING' : 'READY';
    await insertInstant('broadcasts', id, instants[index]!, privateRoomId);
    await source.getRepository(Broadcast).update(id, { visibility, status });
    records.push({ id, visibility, status });
  }
  const order = await ordered('broadcasts', 'room_id', privateRoomId);
  const owner = { id: castHostId, isGuest: false, email: null, passwordHash: null } as User;
  const outsiders = [
    { id: castHostId, isGuest: true } as User,
    { id: otherHostId, isGuest: false } as User,
    { id: hostId, isGuest: true } as User,
  ];
  for (const user of [owner, ...outsiders]) {
    const allowed = new Set(
      records
        .filter((row) => row.status !== 'DELETING' && (user === owner || row.visibility === 'LINK'))
        .map((row) => row.id),
    );
    for (const limit of [1, 2]) {
      await walk(
        (cursor) =>
          service.listByRoomSlug(
            slug,
            { limit: String(limit), ...(cursor ? { cursor } : {}) },
            user,
          ),
        limit,
        order.filter((row) => allowed.has(row.id)),
      );
    }
  }
});

afterAll(async () => {
  try {
    if (dataSource?.isInitialized) await dataSource.destroy();
  } finally {
    try {
      if (created && admin && /^sf_cursor_[a-f0-9]{32}$/.test(databaseName))
        await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
    } finally {
      if (admin?.isInitialized) await admin.destroy();
    }
  }
}, 30_000);

async function walk<T extends { id: string; createdAt: string }>(
  read: (cursor?: string) => Promise<{ items: T[]; nextCursor: string | null }>,
  limit: number,
  expected: Array<{ id: string; ordering: string }>,
): Promise<string[]> {
  const seen: string[] = [];
  let cursor: string | null = null;
  for (let guard = 0; guard < expected.length + 2; guard += 1) {
    const page = await read(cursor ?? undefined);
    expect(page.items.length).toBeLessThanOrEqual(limit);
    for (const item of page.items) {
      const stored = expected.find((row) => row.id === item.id);
      expect(stored).toBeDefined();
      expect(item.createdAt).toBe(`${stored!.ordering.slice(0, 23)}Z`);
      expect(item.createdAt).not.toBe(stored!.ordering);
    }
    seen.push(...page.items.map((item) => item.id));
    if (!page.nextCursor) break;
    const parsed = parseHistoryCursor(page.nextCursor);
    expect(parsed).toEqual({
      ok: true,
      value: {
        createdAt: expected.find((row) => row.id === page.items.at(-1)?.id)!.ordering,
        id: page.items.at(-1)?.id,
      },
    });
    cursor = page.nextCursor;
  }
  expect(seen).toEqual(expected.map((row) => row.id));
  expect(new Set(seen).size).toBe(seen.length);
  return seen;
}

it('pages rooms and broadcasts across microseconds without skips or duplicates', async () => {
  if (!rooms || !broadcasts) throw new Error('Catalog services were not created.');
  const roomPages = rooms;
  const broadcastPages = broadcasts;
  expect(roomOrder.map((row) => row.ordering)).toEqual(instants);
  expect(broadcastOrder.map((row) => row.ordering)).toEqual(instants);
  expect(roomOrder.some((row) => row.id === otherRoomId)).toBe(false);

  await walk(
    (cursor) =>
      roomPages.listForHost(caller(hostId), { limit: '1', ...(cursor ? { cursor } : {}) }),
    1,
    roomOrder,
  );
  await walk(
    (cursor) =>
      roomPages.listForHost(caller(hostId), { limit: '2', ...(cursor ? { cursor } : {}) }),
    2,
    roomOrder,
  );
  const other = await roomPages.listForHost(caller(otherHostId), { limit: '10' });
  expect(other.items.map((item) => item.id)).toEqual([otherRoomId]);
  expect(other.nextCursor).toBeNull();
  expect(other.items[0]?.hostDisplayName).toBe('Sam');

  const first = await roomPages.listForHost(caller(hostId), { limit: '1' });
  const neighbor = roomOrder[1]!;
  const second = await roomPages.listForHost(caller(hostId), {
    limit: '1',
    cursor: first.nextCursor!,
  });
  expect(second.items[0]?.id).toBe(neighbor.id);
  const legacy = encodeHistoryCursor(`${roomOrder[0]!.ordering.slice(0, 23)}Z`, roomOrder[0]!.id);
  expect(legacy).not.toBeNull();
  const legacyPage = await roomPages.listForHost(caller(hostId), { limit: '10', cursor: legacy! });
  expect(legacyPage.items.map((item) => item.id)).not.toContain(neighbor.id);

  await expect(
    roomPages.listForHost(caller(hostId), { cursor: 'not-a-cursor' }),
  ).rejects.toMatchObject({
    response: { statusCode: 400, error: 'invalid_cursor' },
  });
  await expect(roomPages.listForHost(caller(hostId), { limit: '51' })).rejects.toMatchObject({
    response: { statusCode: 400, error: 'invalid_page' },
  });

  const slug = 'CursorCast01';
  await walk(
    (cursor) =>
      broadcastPages.listByRoomSlug(
        slug,
        { limit: '1', ...(cursor ? { cursor } : {}) },
        caller(otherHostId),
      ),
    1,
    broadcastOrder,
  );
  await walk(
    (cursor) =>
      broadcastPages.listByRoomSlug(
        slug,
        { limit: '2', ...(cursor ? { cursor } : {}) },
        caller(otherHostId),
      ),
    2,
    broadcastOrder,
  );
  const foreign = await broadcastPages.listByRoomSlug(
    'CursorOther1',
    { limit: '10' },
    caller(otherHostId),
  );
  expect(foreign.items).toHaveLength(1);
  expect(foreign.items[0]?.roomId).toBe(otherRoomId);
  expect(broadcastOrder.some((row) => row.id === foreign.items[0]?.id)).toBe(false);
  for (const item of foreign.items) expect(parseBroadcast(item)).toEqual(item);
  const catalog = await broadcastPages.listByRoomSlug(slug, { limit: '1' }, caller(otherHostId));
  expect(parseBroadcast(catalog.items[0])).toEqual(catalog.items[0]);
}, 30_000);

it('claims a finished replay once under concurrent PostgreSQL deletes and preserves its room', async () => {
  if (!dataSource || !rooms) throw new Error('Catalog services were not created.');
  const source = dataSource;
  const root = await mkdtemp(join(tmpdir(), 'sf-replay-pg-'));
  try {
    const replayRoomId = randomUUID();
    await insertInstant('rooms', replayRoomId, instants[0]!, castHostId, 'DeleteCast01');
    const repository = source.getRepository(Broadcast);
    const replay = await repository.save(
      repository.create({ roomId: replayRoomId, status: 'READY' }),
    );
    const directory = await prepareBroadcastDirectory(root, replay.id);
    await writeFile(join(directory, 'index.m3u8'), '#EXTM3U');
    let waiting = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reader = {
      read: async () => {
        if (++waiting === 2) release();
        await gate;
        return null;
      },
      close: async () => {},
    };
    const service = new BroadcastsService(repository, rooms, undefined, root, undefined, reader);
    const secondService = new BroadcastsService(
      repository,
      rooms,
      undefined,
      root,
      undefined,
      reader,
    );
    const owner = { id: castHostId, isGuest: false } as User;
    expect(await service.setVisibility(replay.id, owner, { visibility: 'HOST' })).toMatchObject({
      status: 'READY',
      visibility: 'HOST',
    });
    const results = await Promise.allSettled([
      service.deleteReplay(replay.id, owner),
      secondService.deleteReplay(replay.id, owner),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: { response: { error: 'broadcast_not_found' } },
    });
    expect(await repository.findOneBy({ id: replay.id })).toBeNull();
    await expect(readFile(join(directory, 'index.m3u8'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await source.getRepository(Room).findOneBy({ id: replayRoomId })).not.toBeNull();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
