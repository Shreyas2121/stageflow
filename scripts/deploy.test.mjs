import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, copyFileSync, symlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { checkProfile, applyStartupChecks, removeFencedGuard } from '../deploy/ops.mjs';
import {
  EXTERNAL_TOKEN,
  SHARED_DATABASE,
  assertCatalogIdentity,
  assertExternalDatabaseUrl,
  assertPinnedCatalogCommand,
  catalogDumpArgs,
  catalogRestoreArgs,
  dedicatedCompose,
  deploymentMode,
  externalStopPlan,
  externalStorageBytes,
  externalStorageFits,
  inspectArgs,
  interpretInspect,
  interpretRedisPing,
  redisPingArgs,
  serviceDeploymentMode,
} from '../deploy/external.mjs';

test('the service reads the external credential without accessing protected /etc markers', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'sf-credential-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, 'external-services'), `${EXTERNAL_TOKEN}\n`);
  assert.equal(await serviceDeploymentMode({ CREDENTIALS_DIRECTORY: directory }), 'external');
  const unit = readFileSync(new URL('../deploy/stageflow.service', import.meta.url), 'utf8');
  assert.match(unit, /^LoadCredential=external-services:\/etc\/stageflow\/external-services$/m);
  assert.match(unit, /^User=stageflow$/m);
  assert.match(unit, /^InaccessiblePaths=.*\/etc\/stageflow$/m);
  assert.doesNotMatch(unit, /^ExecStartPre=\+/m);
});

test('external startup fails closed for absent, unreadable and malformed credentials', async () => {
  const directory = join(tmpdir(), 'sf-service-credentials');
  const env = { CREDENTIALS_DIRECTORY: directory };
  const missing = async () => {
    throw Object.assign(new Error('missing'), { code: 'ENOENT' });
  };
  for (const directory of [undefined, '', 'relative']) {
    await assert.rejects(serviceDeploymentMode({ CREDENTIALS_DIRECTORY: directory }, missing));
  }
  await assert.rejects(serviceDeploymentMode(env, missing), /credential is required/);
  // Even a fixture credential cannot make the default production mode fall back.
  await assert.rejects(
    serviceDeploymentMode(env, async (path) => {
      if (path === join(directory, 'fixture-only')) return 'sf-c12-disposable';
      return missing();
    }),
    /Dedicated mode is forbidden/,
  );
  await assert.rejects(
    serviceDeploymentMode(env, async () => {
      throw Object.assign(new Error('do not log private paths'), { code: 'EACCES' });
    }),
    /credential could not be read/,
  );
  for (const text of [
    '',
    'sf-external-shared-service',
    ` ${EXTERNAL_TOKEN}`,
    `${EXTERNAL_TOKEN} `,
    `${EXTERNAL_TOKEN}\nextra`,
    `${EXTERNAL_TOKEN}\n\n`,
    `${EXTERNAL_TOKEN}\0`,
    '\ufffd',
  ]) {
    await assert.rejects(
      serviceDeploymentMode(env, async (path) => {
        if (path === join(directory, 'external-services')) return text;
        return missing();
      }),
      /marker is present but invalid/,
    );
  }
});

test('dedicated service mode requires an explicit fixture credential and refuses conflicting authority', async () => {
  const directory = join(tmpdir(), 'sf-service-credentials');
  const env = { CREDENTIALS_DIRECTORY: directory, STAGEFLOW_DEPLOYMENT_MODE: 'dedicated' };
  const reader = (files) => async (path) => {
    if (Object.hasOwn(files, path)) return files[path];
    throw Object.assign(new Error('missing'), { code: 'ENOENT' });
  };
  const fixture = { [join(directory, 'fixture-only')]: 'sf-c12-disposable' };
  assert.equal(await serviceDeploymentMode(env, reader(fixture)), 'dedicated');
  await assert.rejects(serviceDeploymentMode(env, reader({})));
  await assert.rejects(
    serviceDeploymentMode(env, reader({ [join(directory, 'fixture-only')]: 'wrong' })),
  );
  const both = { ...fixture, [join(directory, 'external-services')]: EXTERNAL_TOKEN };
  await assert.rejects(serviceDeploymentMode(env, reader(both)));
  await assert.rejects(serviceDeploymentMode({ CREDENTIALS_DIRECTORY: directory }, reader(both)));
  await assert.rejects(
    serviceDeploymentMode({ ...env, STAGEFLOW_DEPLOYMENT_MODE: 'automatic' }, reader(fixture)),
  );
});

test('the production check CLI refuses a missing credential before dependency or ownership work', () => {
  const directory = mkdtempSync(join(tmpdir(), 'sf-missing-credential-'));
  try {
    const result = spawnSync(process.execPath, ['deploy/ops.mjs', 'check'], {
      cwd: new URL('../', import.meta.url),
      encoding: 'utf8',
      windowsHide: true,
      env: {
        ...process.env,
        CREDENTIALS_DIRECTORY: directory,
        STAGEFLOW_DEPLOYMENT_MODE: 'external',
      },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /external-services credential is required/);
    assert.doesNotMatch(result.stderr, /deployment marker could not be read/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

const profile = {
  NODE_ENV: 'production',
  HOST: '127.0.0.1',
  TRUSTED_PROXIES: '127.0.0.1',
  CORS_ORIGIN: 'https://stageflow.test',
  DATA_ROOT: '/srv/stageflow/media',
  DATABASE_URL: 'postgresql://stageflow:unique@127.0.0.1:5542/stageflow',
  REDIS_URL: 'redis://:unique@127.0.0.1:6381',
  JWT_SECRET: 'a'.repeat(64),
  ENCODER_GLOBAL_LIMIT: '1',
  FFMPEG_THREADS: '1',
};

test('the operations CLI executes through a current release symlink', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'sf-deploy-cli-'));
  assert(root.startsWith(join(tmpdir(), 'sf-deploy-cli-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const release = join(root, 'release');
  mkdirSync(join(release, 'deploy'), { recursive: true });
  copyFileSync(new URL('../deploy/ops.mjs', import.meta.url), join(release, 'deploy/ops.mjs'));
  copyFileSync(
    new URL('../deploy/external.mjs', import.meta.url),
    join(release, 'deploy/external.mjs'),
  );
  symlinkSync(release, join(root, 'current'), 'junction');
  const result = spawnSync(
    process.execPath,
    [join(root, 'current/deploy/ops.mjs'), 'invalid-action'],
    { encoding: 'utf8', windowsHide: true },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /StageFlow invalid-action failed/);
});

test('the profile refuses public dependencies, development defaults, unsafe media and placeholder secrets', () => {
  checkProfile(profile);
  for (const change of [
    { NODE_ENV: 'development' },
    { HOST: '0.0.0.0' },
    { TRUSTED_PROXIES: '0.0.0.0' },
    { CORS_ORIGIN: 'http://stageflow.test' },
    { CORS_ORIGIN: 'https://stageflow.example.com' },
    { DATA_ROOT: '/opt/stageflow/current/media' },
    { DATA_ROOT: 'media' },
    { JWT_SECRET: 'CHANGE_ME'.repeat(8) },
    { DATABASE_URL: 'postgresql://stageflow:unique@db.example.com/stageflow' },
    { REDIS_URL: 'redis://127.0.0.1:6381' },
    { ENCODER_GLOBAL_LIMIT: '2' },
    { FFMPEG_THREADS: '2' },
  ])
    assert.throws(() => checkProfile({ ...profile, ...change }));
});

test('guard recovery refuses all unsafe service states before touching Redis', async () => {
  const stopped = { fenced: true, active: 'inactive', pid: '0', job: '', populated: false };
  let calls = 0;
  const redis = {
    eval: async () => {
      calls++;
      return 1;
    },
  };
  const token = '123:11111111-1111-4111-8111-111111111111';
  for (const change of [
    { fenced: false },
    { active: 'active' },
    { active: 'activating' },
    { active: 'deactivating' },
    { pid: '123' },
    { job: '12/start' },
    { populated: true },
  ])
    await assert.rejects(removeFencedGuard(redis, 'sf_fixture', token, { ...stopped, ...change }));
  assert.equal(calls, 0);
  await assert.rejects(removeFencedGuard(redis, 'sf_fixture', 'wrong', stopped));
  assert.equal(calls, 0);
  await removeFencedGuard(redis, 'sf_fixture', token, stopped);
  assert.equal(calls, 1);
});

test('external mode refuses another database, a superuser, and any shared-container mutation', () => {
  const secret = 'super-secret-db';
  const wrong = `postgresql://stageflow_app:${secret}@127.0.0.1:5432/other_project`;
  let error;
  try {
    assertExternalDatabaseUrl(wrong);
  } catch (caught) {
    error = caught;
  }
  assert.ok(error);
  assert.match(error.message, /stageflow_db/);
  assert.equal(error.message.includes(secret), false);
  assert.throws(() => assertExternalDatabaseUrl(wrong.replace('other_project', 'postgres')));
  assert.throws(() =>
    assertExternalDatabaseUrl(`postgresql://postgres:${secret}@127.0.0.1:5432/${SHARED_DATABASE}`),
  );
  assert.throws(() =>
    assertExternalDatabaseUrl(
      `postgresql://stageflow_app:${secret}@127.0.0.1:5542/${SHARED_DATABASE}`,
    ),
  );
  assert.throws(() =>
    assertExternalDatabaseUrl(
      `postgresql://stageflow_app:${secret}@db.example.com/${SHARED_DATABASE}`,
    ),
  );
  assert.doesNotThrow(() =>
    assertExternalDatabaseUrl(
      `postgresql://stageflow_app:${secret}@127.0.0.1:5432/${SHARED_DATABASE}`,
    ),
  );
  assert.deepEqual(catalogDumpArgs, [
    'docker',
    'exec',
    '-i',
    'shared-postgres',
    'pg_dump',
    '-U',
    'stageflow_app',
    '-d',
    'stageflow_db',
    '--format=custom',
  ]);
  assertPinnedCatalogCommand(catalogDumpArgs);
  assertPinnedCatalogCommand(catalogRestoreArgs);
  assert.equal(catalogRestoreArgs.includes('--create'), false);
  assert.equal(catalogDumpArgs.join(' ').includes(secret), false);
  const hijack = [...catalogDumpArgs];
  hijack[hijack.indexOf('stageflow_db')] = 'other_project';
  assert.throws(() => assertPinnedCatalogCommand(hijack), /stageflow_db/);
  for (const banned of [
    'stop',
    'rm',
    'kill',
    'down',
    'restart',
    'pg_dumpall',
    'FLUSHALL',
    'FLUSHDB',
  ]) {
    assert.throws(() => assertPinnedCatalogCommand([...catalogDumpArgs, banned]));
  }
  assert.throws(() => assertCatalogIdentity('other_project|stageflow_app|f'));
  assert.throws(() => assertCatalogIdentity('stageflow_db|postgres|t'));
  assert.throws(() => assertCatalogIdentity('stageflow_db|stageflow_app|t'));
  assert.throws(() => assertCatalogIdentity('stageflow_db|stageflow_app|f\nextra|role|f'));
  assert.doesNotThrow(() => assertCatalogIdentity('stageflow_db|stageflow_app|f\n'));
  assert.throws(() => inspectArgs('postgres'));
  assert.equal(inspectArgs('shared-postgres').includes('stop'), false);
  assert.equal(redisPingArgs().includes('-a'), false);
  assert.equal(redisPingArgs().join(' ').includes('FLUSH'), false);
  assert.throws(() => interpretInspect('shared-postgres', 'false'));
  assert.throws(() => interpretInspect('shared-postgres', 'true unhealthy'));
  assert.throws(() => interpretInspect('stageflow-redis', 'true starting'));
  assert.doesNotThrow(() => interpretInspect('shared-postgres', 'true healthy'));
  assert.doesNotThrow(() => interpretInspect('stageflow-redis', 'true'));
  assert.throws(() => interpretRedisPing('PONG'));
  assert.throws(() => interpretRedisPing('NOAUTH PONG'));
  assert.doesNotThrow(() => interpretRedisPing('NOAUTH Authentication required.'));
  assert.deepEqual(externalStopPlan(), []);
  const dedicatedStop = dedicatedCompose('stop');
  assert.equal(dedicatedStop.includes('shared-postgres'), false);
  assert.equal(dedicatedStop.includes('stageflow-redis'), false);
  assert.ok(dedicatedStop.includes('stageflow'));
  assert.equal(deploymentMode({ external: undefined, fixtureExists: true }), 'dedicated');
  assert.equal(
    deploymentMode({ external: `${EXTERNAL_TOKEN}\n`, fixtureExists: false }),
    'external',
  );
  assert.throws(() => deploymentMode({ external: 'start-compose', fixtureExists: false }));
  assert.throws(() => deploymentMode({ external: EXTERNAL_TOKEN, fixtureExists: true }));
  const externalEnv = {
    ...profile,
    DATABASE_URL: `postgresql://stageflow_app:${secret}@127.0.0.1:5432/stageflow_db`,
    REDIS_URL: `redis://:${secret}@127.0.0.1:6381/0`,
    DATABASE_POOL_MAX: '4',
  };
  applyStartupChecks(externalEnv, 'dedicated');
  applyStartupChecks(externalEnv, 'external');
  let mismatch;
  try {
    applyStartupChecks({ ...externalEnv, DATABASE_URL: wrong }, 'external');
  } catch (caught) {
    mismatch = caught;
  }
  assert.ok(mismatch);
  assert.equal(mismatch.message.includes(secret), false);
  assert.throws(() => applyStartupChecks({ ...externalEnv, DATABASE_POOL_MAX: '10' }, 'external'));
  assert.throws(() => applyStartupChecks(profile, 'external'));
  checkProfile(profile);
  assert.equal(externalStorageFits(), true);
  assert.ok(
    externalStorageBytes.mediaCap +
      externalStorageBytes.oneLocalBackup +
      externalStorageBytes.minFree <=
      externalStorageBytes.filesystem,
  );
});

test('shell profiles cannot stop shared infrastructure or retarget a catalog command', () => {
  const read = (name) => readFileSync(new URL(`../deploy/${name}`, import.meta.url), 'utf8');
  const region = (source) => {
    const start = source.indexOf('# external-services-begin');
    const end = source.indexOf('# external-services-end');
    assert.ok(start !== -1 && end > start);
    return source.slice(start, end);
  };
  const backup = read('backup.sh');
  const restore = read('restore.sh');
  const infra = read('infra.sh');
  const unit = read('stageflow-infra.service');
  for (const source of [backup, restore, infra, unit]) {
    for (const banned of [
      'pg_dumpall',
      'FLUSHALL',
      'FLUSHDB',
      'DROP DATABASE',
      'docker rm',
      'docker stop',
      'compose down',
      '--create',
    ]) {
      assert.equal(source.includes(banned), false, banned);
    }
  }
  const backupRegion = region(backup);
  assert.match(backupRegion, /dump-catalog/);
  assert.equal(backupRegion.includes('docker'), false);
  assert.equal(backupRegion.includes('pg_dump'), false);
  assert.match(backup, /pg_dump -U stageflow -d stageflow/);
  const restoreRegion = region(restore);
  assert.match(restoreRegion, /restore-catalog/);
  assert.equal(restoreRegion.includes('docker'), false);
  assert.match(restore, /pg_restore -U stageflow -d stageflow/);
  const infraRegion = region(infra);
  assert.match(infraRegion, /probe/);
  assert.equal(infraRegion.includes('docker'), false);
  assert.match(infra, /--project-name stageflow/);
  assert.equal(infra.includes('shared-postgres'), true);
  assert.match(unit, /infra\.sh start/);
  assert.match(unit, /infra\.sh stop/);
  assert.equal(unit.includes('compose'), false);
  const example = read('stageflow.external.env.example');
  assert.match(example, /postgresql:\/\/stageflow_app:.+@127\.0\.0\.1:5432\/stageflow_db/);
  assert.match(example, /^DATABASE_POOL_MAX=4$/m);
  assert.match(example, /STORAGE_MAX_BYTES=1073741824/);
  assert.match(example, /MIN_FREE_BYTES=2147483648/);
  assert.match(example, /RECORDING_MAX_BYTES=268435456/);
  assert.match(example, /ENCODER_GLOBAL_LIMIT=1/);
  assert.equal(read('stageflow.env.example').includes('DATABASE_POOL_MAX'), false);
  assert.match(read('stageflow.env.example'), /127\.0\.0\.1:5542\/stageflow/);
  assert.equal(
    deploymentMode({ external: read('external-services.example'), fixtureExists: false }),
    'external',
  );
});

test('recovery uses one compare-delete and refuses a missing or replacement owner', async () => {
  let argumentsSeen;
  const redis = {
    eval: async (...args) => {
      argumentsSeen = args;
      return 0;
    },
  };
  const token = '123:11111111-1111-4111-8111-111111111111';
  await assert.rejects(
    removeFencedGuard(redis, 'sf_fixture', token, {
      fenced: true,
      active: 'failed',
      pid: '0',
      job: '',
      populated: false,
    }),
    /nothing was deleted/,
  );
  assert.deepEqual(argumentsSeen.slice(1), [1, 'sf_fixture:owner', token]);
  assert.match(argumentsSeen[0], /GET.*ARGV\[1\].*DEL/);
});
