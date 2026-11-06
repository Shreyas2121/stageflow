import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { LiveRepository } from '../live/live.repository';
import { LiveService, type LiveSession, type LiveTransport } from '../live/live.service';
import { SerializedOperations } from '../live/serialized-operations';
import { liveKeys, roomPrefix } from '../live/live.keys';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { DataSource } from 'typeorm';
import { databaseOptions } from '../database/data-source';
import { User } from '../users/user.entity';
import { Room } from './room.entity';
import { RoomsService } from './rooms.service';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { RoomsController } from './rooms.controller';
import { SessionsService } from '../sessions/sessions.service';
import { JwtAuthGuard } from '../sessions/jwt-auth.guard';
import { ApiExceptionFilter } from '../http/api-exception.filter';

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
let app: NestExpressApplication | undefined;
let url: string;
const jwt = new JwtService({
  secret: randomUUID(),
  signOptions: { algorithm: 'HS256', expiresIn: '1h' },
});

// Vitest does not emit Nest constructor metadata.
Reflect.defineMetadata('design:paramtypes', [RoomsService], RoomsController);
Reflect.defineMetadata('design:paramtypes', [SessionsService], JwtAuthGuard);

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
  const rooms = new RoomsService(source.getRepository(Room));
  const sessions = new SessionsService(source.getRepository(User), jwt);
  class FixtureModule {}
  Module({
    controllers: [RoomsController],
    providers: [
      { provide: RoomsService, useValue: rooms },
      { provide: SessionsService, useValue: sessions },
    ],
  })(FixtureModule);
  app = await NestFactory.create<NestExpressApplication>(FixtureModule, {
    logger: false,
    abortOnError: false,
  });
  app.setGlobalPrefix('api');
  app.useGlobalFilters(new ApiExceptionFilter());
  await app.listen(0, '127.0.0.1');
  url = await app.getUrl();
}, 30_000);

afterAll(async () => {
  try {
    if (app) await app.close();
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

it('keeps guest title/mode create immediate', async () => {
  const db = database();
  const host = await db.getRepository(User).findOneByOrFail({ id: hostId });
  const service = new RoomsService(db.getRepository(Room));
  const response = await service.create(host, { title: 'Immediate', mode: 'MEETING' });
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
});

async function createOverHttp(user: User, fields: Record<string, unknown>) {
  const token = await jwt.signAsync({ sub: user.id, sv: user.sessionVersion, guest: user.isGuest });
  return fetch(`${url}/api/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ title: 'HTTP room', mode: 'MEETING', ...fields }),
  });
}

it('creates and reads past schedules over authenticated HTTP for a Google-only host', async () => {
  const db = database();
  const host = await db.getRepository(User).save({
    displayName: 'Google host',
    isGuest: false,
    email: null,
    passwordHash: null,
    googleSubject: `schedule-${randomUUID()}`,
  });
  for (const mode of ['MEETING', 'WEBINAR']) {
    const response = await createOverHttp(host, {
      status: 'SCHEDULED',
      scheduledStartAt: '2000-01-01T00:00:00.123Z',
      mode,
      requireAdmission: mode === 'MEETING',
      hostId,
      isGuest: true,
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { id: string; slug: string };
    expect(body).toMatchObject({
      hostId: host.id,
      status: 'SCHEDULED',
      mode,
      scheduledStartAt: '2000-01-01T00:00:00.123Z',
      requireAdmission: mode === 'MEETING',
    });
    const token = await jwt.signAsync({ sub: host.id, sv: host.sessionVersion, guest: false });
    const fetched = await fetch(`${url}/api/rooms/${body.slug}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(fetched.status).toBe(200);
    expect(await fetched.json()).toEqual(body);
    expect(await db.getRepository(Room).findOneByOrFail({ id: body.id })).toMatchObject({
      status: 'SCHEDULED',
    });
  }
  const immediate = await createOverHttp(host, {});
  expect(immediate.status).toBe(201);
  expect(await immediate.json()).toMatchObject({
    status: 'LIVE',
    scheduledStartAt: null,
    requireAdmission: false,
  });
});

it('rejects guest scheduling and invalid host bodies over HTTP without inserting rows', async () => {
  const db = database();
  const guest = await db.getRepository(User).findOneByOrFail({ id: hostId });
  const host = await db
    .getRepository(User)
    .save({ displayName: 'Host', isGuest: false, email: 'schedule@example.test' });
  const cases = [
    {
      user: guest,
      fields: { status: 'LIVE', isGuest: false },
      status: 403,
      error: 'schedule_not_allowed',
      message: 'Create a host account before scheduling a room.',
    },
    {
      user: guest,
      fields: { scheduledStartAt: null },
      status: 403,
      error: 'schedule_not_allowed',
      message: 'Create a host account before scheduling a room.',
    },
    {
      user: guest,
      fields: { requireAdmission: false },
      status: 403,
      error: 'schedule_not_allowed',
      message: 'Create a host account before scheduling a room.',
    },
    {
      user: host,
      fields: { status: 'ENDED' },
      status: 400,
      error: 'invalid_schedule',
      message: 'Choose a live or scheduled room.',
    },
    {
      user: host,
      fields: { status: 'SCHEDULED' },
      status: 400,
      error: 'invalid_schedule',
      message: 'Enter a UTC start time.',
    },
    {
      user: host,
      fields: { status: 'LIVE', scheduledStartAt: '2000-01-01T00:00:00.000Z' },
      status: 400,
      error: 'invalid_schedule',
      message: 'Enter a UTC start time.',
    },
    {
      user: host,
      fields: { mode: 'WEBINAR', requireAdmission: true },
      status: 400,
      error: 'invalid_admission',
      message: 'Admission applies to meetings only.',
    },
  ];
  const before = await db.getRepository(Room).count();
  for (const test of cases) {
    const response = await createOverHttp(test.user, test.fields);
    expect(response.status).toBe(test.status);
    expect(await response.json()).toEqual({
      statusCode: test.status,
      error: test.error,
      message: test.message,
    });
    expect(await db.getRepository(Room).count()).toBe(before);
  }
  const immediate = await createOverHttp(guest, {});
  expect(immediate.status).toBe(201);
  expect(await immediate.json()).toMatchObject({
    hostId: guest.id,
    status: 'LIVE',
    scheduledStartAt: null,
    requireAdmission: false,
  });
});

it('cancels a past scheduled room durably before clearing Redis, without inserting a broadcast', async () => {
  const db = database();
  const rooms = new RoomsService(db.getRepository(Room));
  const host = {
    ...(await db.getRepository(User).findOneByOrFail({ id: hostId })),
    isGuest: false,
  };
  const scheduled = await rooms.create(host, {
    title: 'Cancel before Start',
    mode: 'WEBINAR',
    status: 'SCHEDULED',
    scheduledStartAt: '2000-01-01T00:00:00.000Z',
  });
  expect((await rooms.getById(scheduled.id))?.status).toBe('SCHEDULED');
  const namespace = 'sf_itest_schedule_' + randomUUID().replaceAll('-', '');
  const prefix = roomPrefix(scheduled.id, namespace);
  if (!process.env.REDIS_URL) throw new Error('REDIS_URL is required.');
  const redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 0 });
  const repository = new LiveRepository(redis);
  const sessions: LiveSession[] = [];
  const transport: LiveTransport = {
    join: async () => {},
    leave: async () => {},
    forceMute: () => {},
    publish: () => {},
    peer: (id) => ({ connected: true, roomId: sessions.find((p) => p.id === id)?.room?.roomId }),
    end: async () => {
      expect(await rooms.getById(scheduled.id)).toMatchObject({
        status: 'ENDED',
        endedAt: expect.any(Date),
      });
      expect(await redis.exists(...liveKeys(prefix))).toBe(0);
      for (const s of sessions) s.room = undefined;
    },
  };
  const service = new LiveService(
    rooms,
    repository,
    new SerializedOperations(),
    undefined,
    namespace,
  );
  try {
    for (const userId of [host.id, randomUUID()]) {
      const session: LiveSession = {
        id: randomUUID(),
        user: { id: userId, displayName: 'Guest' },
        connected: true,
        room: undefined,
      };
      sessions.push(session);
      expect(
        await service.join(
          session,
          { roomId: scheduled.id, isAudioMuted: false, isVideoOff: false, isSyntheticBot: false },
          transport,
          randomUUID(),
        ),
      ).toEqual({ ok: true });
    }
    expect(await redis.zcard(prefix + ':waiting')).toBe(1);
    // At the first cleanup write, PostgreSQL must already be ended.
    const apply = repository.apply.bind(repository);
    repository.apply = async (key, room, command) => {
      if (command.type === 'cancel')
        expect((await rooms.getById(scheduled.id))?.status).toBe('ENDED');
      return apply(key, room, command);
    };
    expect(await service.scheduleCommand(sessions[0]!, 'cancel', transport)).toEqual({ ok: true });
    expect(await db.query('SELECT id FROM broadcasts WHERE room_id = $1', [scheduled.id])).toEqual(
      [],
    );
    expect(await rooms.startScheduled(scheduled.id)).toBe(false);
    expect(await rooms.cancelScheduled(scheduled.id)).toBe(false);
  } finally {
    service.onModuleDestroy();
    await repository.deleteRoom(prefix);
    redis.disconnect();
  }
});

it('starts only SCHEDULED catalog rows and cannot cancel a live room', async () => {
  const db = database();
  const rooms = new RoomsService(db.getRepository(Room));
  const host = {
    ...(await db.getRepository(User).findOneByOrFail({ id: hostId })),
    isGuest: false,
  };
  const room = await rooms.create(host, {
    title: 'Explicit Start',
    mode: 'MEETING',
    status: 'SCHEDULED',
    scheduledStartAt: '2000-01-01T00:00:00.000Z',
  });
  expect((await rooms.getById(room.id))?.status).toBe('SCHEDULED');
  expect(await rooms.startScheduled(room.id)).toBe(true);
  expect(await rooms.startScheduled(room.id)).toBe(false);
  expect(await rooms.cancelScheduled(room.id)).toBe(false);
  expect(await rooms.getById(room.id)).toMatchObject({ status: 'LIVE', endedAt: null });
});

it('can finish live shutdown when an interrupted Start left the catalog SCHEDULED', async () => {
  const db = database();
  const rooms = new RoomsService(db.getRepository(Room));
  const host = {
    ...(await db.getRepository(User).findOneByOrFail({ id: hostId })),
    isGuest: false,
  };
  const room = await rooms.create(host, {
    title: 'Interrupted Start shutdown',
    mode: 'MEETING',
    status: 'SCHEDULED',
    scheduledStartAt: '2000-01-01T00:00:00.000Z',
  });
  await rooms.end(room.id);
  expect(await rooms.getById(room.id)).toMatchObject({
    status: 'ENDED',
    endedAt: expect.any(Date),
  });
});
