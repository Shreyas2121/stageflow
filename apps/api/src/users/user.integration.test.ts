import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { DataSource } from 'typeorm';
import { databaseOptions } from '../database/data-source';
import { AddHostCredentials1793923200000 } from '../migrations/1793923200000-AddHostCredentials';
import { User } from './user.entity';

const adminUrl = process.env.DATABASE_URL;
if (!adminUrl) throw new Error('DATABASE_URL is required.');
const databaseName = `sf_credentials_${randomUUID().replaceAll('-', '')}`;
const databaseUrl = new URL(adminUrl);
databaseUrl.pathname = `/${databaseName}`;
const legacyGuestId = randomUUID();
let created = false;
let admin: DataSource | undefined;
let dataSource: DataSource | undefined;

beforeAll(async () => {
  if (!/^sf_credentials_[a-f0-9]{32}$/.test(databaseName))
    throw new Error('Unexpected database name.');
  if (databaseOptions.type !== 'postgres' || !Array.isArray(databaseOptions.migrations))
    throw new Error('Expected registered PostgreSQL migrations.');
  const extra = { connectionTimeoutMillis: 3000, statement_timeout: 5000, query_timeout: 6000 };
  admin = new DataSource({ type: 'postgres', url: adminUrl, extra });
  await admin.initialize();
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  created = true;
  dataSource = new DataSource({
    ...databaseOptions,
    url: databaseUrl.href,
    migrations: databaseOptions.migrations.slice(0, -1),
    extra,
  });
  await dataSource.initialize();
  await dataSource.runMigrations();
  await dataSource.query('INSERT INTO users (id, display_name) VALUES ($1, $2)', [
    legacyGuestId,
    'Legacy guest',
  ]);
  await dataSource.destroy();
  dataSource = new DataSource({ ...databaseOptions, url: databaseUrl.href, extra });
  await dataSource.initialize();
  expect((await dataSource.runMigrations()).map((migration) => migration.name)).toEqual([
    'AddHostCredentials1793923200000',
  ]);
  expect(await dataSource.runMigrations()).toEqual([]);
}, 30_000);

afterAll(async () => {
  try {
    if (dataSource?.isInitialized) await dataSource.destroy();
  } finally {
    try {
      if (created && admin && /^sf_credentials_[a-f0-9]{32}$/.test(databaseName))
        await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
    } finally {
      if (admin?.isInitialized) await admin.destroy();
    }
  }
}, 30_000);

function database(): DataSource {
  if (!dataSource?.isInitialized) throw new Error('Disposable database is not open.');
  return dataSource;
}

it('backfills existing guests and keeps guest inserts valid with null credentials', async () => {
  const users = database().getRepository(User);
  const legacy = await users
    .createQueryBuilder('user')
    .addSelect('user.passwordHash')
    .where('user.id = :id', { id: legacyGuestId })
    .getOneOrFail();
  expect(legacy).toMatchObject({
    id: legacyGuestId,
    displayName: 'Legacy guest',
    email: null,
    passwordHash: null,
    isGuest: true,
    sessionVersion: 0,
  });
  for (const displayName of ['New guest', 'Another guest']) {
    const guest = await users.save(users.create({ displayName }));
    expect(await users.findOneByOrFail({ id: guest.id })).toMatchObject({
      email: null,
      isGuest: true,
      sessionVersion: 0,
    });
  }
});

it('persists host credentials, hides the hash by default, and enforces email uniqueness', async () => {
  const users = database().getRepository(User);
  const host = await users.save(
    users.create({
      displayName: 'Host',
      email: 'host@example.test',
      passwordHash: 'test-only-hash-marker',
      isGuest: false,
      sessionVersion: 1,
    }),
  );
  const loaded = await users.findOneByOrFail({ id: host.id });
  expect(loaded).toMatchObject({ email: 'host@example.test', isGuest: false, sessionVersion: 1 });
  expect(loaded.passwordHash).toBeUndefined();
  const credentials = await users
    .createQueryBuilder('user')
    .addSelect('user.passwordHash')
    .where('user.id = :id', { id: host.id })
    .getOneOrFail();
  expect(credentials.passwordHash).toBe('test-only-hash-marker');
  await expect(
    users.save(users.create({ displayName: 'Other host', email: host.email, isGuest: false })),
  ).rejects.toMatchObject({ driverError: { code: '23505' } });
});

it('rolls back the credential columns without removing the existing guest', async () => {
  const runner = database().createQueryRunner();
  await runner.connect();
  await runner.startTransaction();
  try {
    await new AddHostCredentials1793923200000().down(runner);
    const table = await runner.getTable('users');
    const columns = table?.columns.map((column) => column.name);
    expect(columns).toEqual(['id', 'display_name', 'is_guest', 'created_at']);
    const legacy: unknown = await runner.query('SELECT id FROM users WHERE id = $1', [
      legacyGuestId,
    ]);
    expect(legacy).toEqual([{ id: legacyGuestId }]);
  } finally {
    await runner.rollbackTransaction();
    await runner.release();
  }
});
