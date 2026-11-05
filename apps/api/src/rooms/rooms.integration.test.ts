import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { DataSource } from 'typeorm';
import { databaseOptions } from '../database/data-source';
import { User } from '../users/user.entity';
import { Room } from './room.entity';
import { RoomsService } from './rooms.service';

const adminUrl = process.env.DATABASE_URL;
if (!adminUrl) throw new Error('DATABASE_URL is required.');
const databaseName = `sf_schedule_${randomUUID().replaceAll('-', '')}`;
const databaseUrl = new URL(adminUrl);
databaseUrl.pathname = `/${databaseName}`;
const hostId = randomUUID();
const legacyIds = [randomUUID(), randomUUID()];
let admin: DataSource | undefined;
let source: DataSource | undefined;
let created = false;

beforeAll(async () => {
  if (!/^sf_schedule_[a-f0-9]{32}$/.test(databaseName))
    throw new Error('Unexpected database name.');
  if (databaseOptions.type !== 'postgres' || !Array.isArray(databaseOptions.migrations))
    throw new Error('Expected registered PostgreSQL migrations.');
  const extra = { connectionTimeoutMillis: 3000, statement_timeout: 5000, query_timeout: 6000 };
  admin = new DataSource({ type: 'postgres', url: adminUrl, extra });
  await admin.initialize();
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  created = true;
  source = new DataSource({
    ...databaseOptions,
    url: databaseUrl.href,
    migrations: databaseOptions.migrations.slice(0, -1),
    extra,
  });
  await source.initialize();
  await source.runMigrations();
  await source.query('INSERT INTO users (id, display_name) VALUES ($1, $2)', [hostId, 'Ava']);
  for (const [index, status] of ['LIVE', 'ENDED'].entries()) {
    await source.query(
      `INSERT INTO rooms (id, slug, title, mode, status, host_id)
       VALUES ($1, $2, 'Legacy room', 'MEETING', $3, $4)`,
      [legacyIds[index], `LegacyRoom0${index}`, status, hostId],
    );
  }
  await source.destroy();
  source = new DataSource({ ...databaseOptions, url: databaseUrl.href, extra });
  await source.initialize();
  expect((await source.runMigrations()).map((migration) => migration.name)).toEqual([
    'AddRoomSchedule1794182400000',
  ]);
  expect(await source.runMigrations()).toEqual([]);
}, 30_000);

afterAll(async () => {
  try {
    if (source?.isInitialized) await source.destroy();
  } finally {
    try {
      if (created && admin && /^sf_schedule_[a-f0-9]{32}$/.test(databaseName))
        await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
    } finally {
      if (admin?.isInitialized) await admin.destroy();
    }
  }
}, 30_000);

function database(): DataSource {
  if (!source?.isInitialized) throw new Error('Disposable database is not open.');
  return source;
}

it('preserves legacy statuses and backfills null start and false admission', async () => {
  const rooms = database().getRepository(Room);
  for (const [index, status] of ['LIVE', 'ENDED'].entries()) {
    expect(await rooms.findOneByOrFail({ id: legacyIds[index] })).toMatchObject({
      status,
      scheduledStartAt: null,
      requireAdmission: false,
    });
  }
});

it('stores a past scheduled instant and exposes it through the catalog', async () => {
  const rooms = database().getRepository(Room);
  const room = await rooms.save(
    rooms.create({
      slug: 'ScheduleTest',
      title: 'Scheduled',
      mode: 'MEETING',
      status: 'SCHEDULED',
      hostId,
      scheduledStartAt: new Date('2000-01-01T00:00:00.123Z'),
      requireAdmission: true,
    }),
  );
  expect(await new RoomsService(rooms).getBySlug(room.slug)).toMatchObject({
    status: 'SCHEDULED',
    scheduledStartAt: '2000-01-01T00:00:00.123Z',
    requireAdmission: true,
  });
});

it('keeps title/mode create immediate and does not accept scheduling fields yet', async () => {
  const db = database();
  const host = await db.getRepository(User).findOneByOrFail({ id: hostId });
  const service = new RoomsService(db.getRepository(Room));
  for (const extra of [
    {},
    { status: 'SCHEDULED', scheduledStartAt: '2000-01-01T00:00:00.000Z', requireAdmission: true },
  ]) {
    const response = await service.create(host, { title: 'Immediate', mode: 'MEETING', ...extra });
    expect(response).toMatchObject({
      status: 'LIVE',
      scheduledStartAt: null,
      requireAdmission: false,
    });
    expect(await db.getRepository(Room).findOneByOrFail({ id: response.id })).toMatchObject({
      status: 'LIVE',
      scheduledStartAt: null,
      requireAdmission: false,
    });
    expect(await service.getBySlug(response.slug)).toEqual(response);
  }
});
