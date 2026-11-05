import { randomUUID } from 'node:crypto';
import { JwtService } from '@nestjs/jwt';
import { Redis } from 'ioredis';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { databaseOptions } from '../database/data-source';
import { LiveConnection } from '../live/live.connection';
import { User } from '../users/user.entity';
import { Room } from '../rooms/room.entity';
import { Broadcast } from '../broadcasts/broadcast.entity';
import { SessionsService } from './sessions.service';

const adminUrl = process.env.DATABASE_URL;
if (!adminUrl) throw new Error('DATABASE_URL is required.');
const databaseName = `sf_accounts_${randomUUID().replaceAll('-', '')}`;
const databaseUrl = new URL(adminUrl);
databaseUrl.pathname = `/${databaseName}`;
const namespace = `sf:itest:accounts:${randomUUID()}`;
const keys: string[] = [];
const redis = new Redis(process.env.REDIS_URL!, {
  lazyConnect: true,
  connectTimeout: 3000,
  commandTimeout: 3000,
  enableOfflineQueue: false,
  maxRetriesPerRequest: 0,
  retryStrategy: () => null,
});
const live = new LiveConnection(redis, namespace);
const jwt = new JwtService({
  secret: randomUUID(),
  signOptions: { algorithm: 'HS256', expiresIn: '12h' },
});
let created = false;
let admin: DataSource | undefined;
let source: DataSource;
let service: SessionsService;

beforeAll(async () => {
  if (!/^sf_accounts_[a-f0-9]{32}$/.test(databaseName))
    throw new Error('Unexpected database name.');
  if (databaseOptions.type !== 'postgres') throw new Error('Expected PostgreSQL options.');
  const extra = { connectionTimeoutMillis: 3000, statement_timeout: 5000, query_timeout: 6000 };
  admin = new DataSource({ type: 'postgres', url: adminUrl, extra });
  await admin.initialize();
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  created = true;
  source = new DataSource({ ...databaseOptions, url: databaseUrl.href, extra });
  await source.initialize();
  await source.runMigrations();
  await redis.connect();
  await redis.ping();
  service = new SessionsService(source.getRepository(User), jwt);
}, 30_000);

afterAll(async () => {
  try {
    if (keys.length && redis.status === 'ready') await redis.del(...keys);
  } finally {
    redis.disconnect();
    try {
      if (source?.isInitialized) await source.destroy();
    } finally {
      try {
        if (created && admin && /^sf_accounts_[a-f0-9]{32}$/.test(databaseName))
          await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
      } finally {
        if (admin?.isInitialized) await admin.destroy();
      }
    }
  }
}, 30_000);

async function guest() {
  return source.getRepository(User).save({ displayName: 'Same name', isGuest: true });
}

async function credentials(id: string) {
  return source
    .getRepository(User)
    .createQueryBuilder('user')
    .addSelect('user.passwordHash')
    .where('user.id = :id', { id })
    .getOneOrFail();
}

async function addMembership(userId: string) {
  const key = `${namespace}:room:${randomUUID()}:participants`;
  keys.push(key);
  await redis.hset(key, randomUUID(), JSON.stringify({ userId, suspended: true }));
}

it('promotes one of two same-name users without moving either room or broadcast', async () => {
  const owner = await guest();
  const other = await guest();
  const rooms = source.getRepository(Room);
  const broadcasts = source.getRepository(Broadcast);
  for (const user of [owner, other]) {
    const room = await rooms.save({
      hostId: user.id,
      slug: randomUUID().slice(0, 12),
      title: 'Owned room',
      mode: 'MEETING',
      status: 'ENDED',
    });
    await broadcasts.save({ roomId: room.id, status: 'READY' });
  }
  const beforeRooms = await rooms.find({ order: { id: 'ASC' } });
  const beforeBroadcasts = await broadcasts.find({ order: { id: 'ASC' } });
  const beforeOther = await credentials(other.id);
  const oldToken = await jwt.signAsync({ sub: owner.id, sv: 0, guest: true });
  const session = await service.promote(owner, ' OWNER@EXAMPLE.TEST ', 'test-password', (id) =>
    live.hasUserMembership(id),
  );
  expect(session).toMatchObject({ userId: owner.id, displayName: owner.displayName });
  expect(await rooms.find({ order: { id: 'ASC' } })).toEqual(beforeRooms);
  const promotedBroadcasts = await broadcasts.find({ order: { id: 'ASC' } });
  expect(promotedBroadcasts).toEqual(beforeBroadcasts);
  expect(promotedBroadcasts.map((row) => row.visibility)).toEqual(['LINK', 'LINK']);
  expect(await credentials(other.id)).toEqual(beforeOther);
  await expect(service.verifyToken(oldToken)).rejects.toMatchObject({
    response: { error: 'unauthorized' },
  });
  await expect(service.verifyToken(session.token)).resolves.toMatchObject({
    id: owner.id,
    isGuest: false,
    sessionVersion: 1,
  });
  await expect(service.login('owner@example.test', 'test-password')).resolves.toMatchObject({
    userId: owner.id,
  });
  const beforeConflict = await credentials(other.id);
  await expect(
    service.promote(other, 'owner@example.test', 'test-password', (id) =>
      live.hasUserMembership(id),
    ),
  ).rejects.toMatchObject({ response: { error: 'email_taken' } });
  expect(await credentials(other.id)).toEqual(beforeConflict);
});

it.each(['before', 'after'])(
  'rejects a suspended membership arriving %s the promotion write and preserves the guest',
  async (when) => {
    const owner = await guest();
    const before = await credentials(owner.id);
    if (when === 'before') await addMembership(owner.id);
    let calls = 0;
    const membership = async (id: string) => {
      calls++;
      if (when === 'after' && calls === 2) await addMembership(id);
      return live.hasUserMembership(id);
    };
    await expect(
      service.promote(owner, `${randomUUID()}@example.test`, 'test-password', membership),
    ).rejects.toMatchObject({ response: { statusCode: 409, error: 'membership_active' } });
    expect(await credentials(owner.id)).toEqual(before);
    expect(calls).toBe(when === 'before' ? 1 : 2);
  },
);

it('rolls back the write even when Redis and the explicit restore both fail', async () => {
  const owner = await guest();
  const before = await credentials(owner.id);
  const sign = vi.spyOn(jwt, 'signAsync');
  let calls = 0;
  try {
    await expect(
      service.promote(owner, 'rollback@example.test', 'test-password', async () => {
        calls++;
        if (calls === 1) return false;
        // Abort this owned transaction so its compensating save also fails.
        await source.query(
          'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND state = $2',
          [databaseName, 'idle in transaction'],
        );
        throw new Error('Redis unavailable');
      }),
    ).rejects.toMatchObject({ response: { statusCode: 503, error: 'server_busy' } });
    expect(await credentials(owner.id)).toEqual(before);
    expect(sign).not.toHaveBeenCalled();
  } finally {
    sign.mockRestore();
  }
});

it('serializes simultaneous password changes so only one stale bearer can commit', async () => {
  const registered = await service.register('Host', 'password@example.test', 'old-password');
  const caller = await service.verifyToken(registered.token);
  const results = await Promise.allSettled([
    service.changePassword(caller, 'old-password', 'new-password-one'),
    service.changePassword(caller, 'old-password', 'new-password-two'),
  ]);
  expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
  const failure = results.find((result) => result.status === 'rejected');
  expect(failure?.reason).toMatchObject({ response: { statusCode: 401, error: 'unauthorized' } });
  expect(await credentials(caller.id)).toMatchObject({ sessionVersion: 1 });
  await expect(service.verifyToken(registered.token)).rejects.toMatchObject({
    response: { error: 'unauthorized' },
  });
  const index = results.findIndex((result) => result.status === 'fulfilled');
  await expect(
    service.login('password@example.test', index === 0 ? 'new-password-one' : 'new-password-two'),
  ).resolves.toMatchObject({ userId: caller.id });
  await expect(service.login('password@example.test', 'old-password')).rejects.toMatchObject({
    response: { error: 'unauthorized' },
  });
});
