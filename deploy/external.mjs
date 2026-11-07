import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createReadStream, createWriteStream, realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const EXTERNAL_TOKEN = 'sf-external-shared-services';
export const SHARED_POSTGRES_CONTAINER = 'shared-postgres';
export const SHARED_REDIS_CONTAINER = 'stageflow-redis';
export const SHARED_DATABASE = 'stageflow_db';
export const SHARED_ROLE = 'stageflow_app';
export const EXTERNAL_MARKER = '/etc/stageflow/external-services';
export const FIXTURE_MARKER = '/etc/stageflow/fixture-only';

export const externalStorageBytes = {
  filesystem: 8 * 1024 * 1024 * 1024,
  mediaCap: 1073741824,
  minFree: 2147483648,
  recordingMax: 268435456,
  oneLocalBackup: 1073741824,
};

const IDENTITY_SQL =
  'SELECT current_database(), current_user, r.rolsuper FROM pg_roles r WHERE r.rolname = current_user';

export const catalogDumpArgs = [
  'docker',
  'exec',
  '-i',
  SHARED_POSTGRES_CONTAINER,
  'pg_dump',
  '-U',
  SHARED_ROLE,
  '-d',
  SHARED_DATABASE,
  '--format=custom',
];

export const catalogRestoreArgs = [
  'docker',
  'exec',
  '-i',
  SHARED_POSTGRES_CONTAINER,
  'pg_restore',
  '-U',
  SHARED_ROLE,
  '-d',
  SHARED_DATABASE,
  '--clean',
  '--if-exists',
  '--no-owner',
  '--exit-on-error',
  '--single-transaction',
];

export const identityQueryArgs = [
  'docker',
  'exec',
  '-i',
  SHARED_POSTGRES_CONTAINER,
  'psql',
  '-U',
  SHARED_ROLE,
  '-d',
  SHARED_DATABASE,
  '-v',
  'ON_ERROR_STOP=1',
  '-tAc',
  IDENTITY_SQL,
];

function refuse(message) {
  throw new assert.AssertionError({ message, operator: 'external' });
}

function markerToken(text) {
  const normalized = String(text).replace(/\r\n/g, '\n');
  const token = normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized;
  if (!token || token !== token.trim() || token.includes('\n')) return '';
  return token;
}

export function deploymentMode({ external, fixtureExists }) {
  if (external === undefined) return 'dedicated';
  if (markerToken(external) !== EXTERNAL_TOKEN) {
    refuse(
      'Refusing: external-services marker is present but invalid. Dedicated containers will not start.',
    );
  }
  if (fixtureExists) {
    refuse(
      'Refusing: fixture and external-services markers are both present. Nothing was started or stopped.',
    );
  }
  return 'external';
}

export function externalStorageFits(bytes = externalStorageBytes) {
  return (
    bytes.recordingMax <= bytes.mediaCap &&
    bytes.mediaCap + bytes.oneLocalBackup + bytes.minFree <= bytes.filesystem
  );
}

function loopback(hostname) {
  return ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(hostname);
}

export function assertExternalDatabaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    refuse('Refusing: database URL is invalid.');
  }
  if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') {
    refuse('Refusing: database URL must use PostgreSQL.');
  }
  if (!loopback(url.hostname)) refuse('Refusing: database host is not loopback.');
  if (url.port !== '5432') refuse('Refusing: shared PostgreSQL port must be 5432.');
  if (decodeURIComponent(url.username) !== SHARED_ROLE) {
    refuse('Refusing: database role must be stageflow_app.');
  }
  if (url.pathname !== `/${SHARED_DATABASE}`) {
    refuse('Refusing: database name must be stageflow_db.');
  }
  if (!url.password) refuse('Refusing: database password is missing.');
}

export function assertExternalRuntime(env) {
  assertExternalDatabaseUrl(env.DATABASE_URL);
  let redis;
  try {
    redis = new URL(env.REDIS_URL);
  } catch {
    refuse('Refusing: Redis URL is invalid.');
  }
  if (redis.protocol !== 'redis:' && redis.protocol !== 'rediss:') {
    refuse('Refusing: Redis URL must use Redis.');
  }
  if (!loopback(redis.hostname)) refuse('Refusing: Redis host is not loopback.');
  if (redis.port !== '6381') refuse('Refusing: Redis port must be 6381.');
  if (!redis.password) refuse('Refusing: Redis password is missing.');
  if (!['', '/', '/0'].includes(redis.pathname)) {
    refuse('Refusing: Redis database index must be 0.');
  }
  if (String(env.DATABASE_POOL_MAX ?? '').trim() !== '4') {
    refuse('Refusing: shared PostgreSQL requires DATABASE_POOL_MAX=4.');
  }
}

export function assertAllowedContainer(name) {
  if (name !== SHARED_POSTGRES_CONTAINER && name !== SHARED_REDIS_CONTAINER) {
    refuse('Refusing: unexpected container. StageFlow will not change it.');
  }
}

export function inspectArgs(name) {
  assertAllowedContainer(name);
  return [
    'docker',
    'inspect',
    '-f',
    '{{.State.Running}} {{if .State.Health}}{{.State.Health.Status}}{{end}}',
    name,
  ];
}

export function redisPingArgs() {
  return ['docker', 'exec', SHARED_REDIS_CONTAINER, 'redis-cli', 'ping'];
}

export function interpretInspect(name, text) {
  assertAllowedContainer(name);
  const [running, health = ''] = String(text).trim().split(/\s+/);
  if (running !== 'true') {
    refuse(`Refusing: ${name} is not running. StageFlow will not start it.`);
  }
  if (health === 'unhealthy' || health === 'starting') {
    refuse(`Refusing: ${name} is ${health}. StageFlow will not restart it.`);
  }
  if (health && health !== 'healthy') {
    refuse(`Refusing: ${name} health is not recognized. StageFlow will not change the container.`);
  }
}

export function interpretRedisPing(output) {
  const text = String(output);
  if (/\bPONG\b/.test(text)) refuse('Refusing: Redis answered an unauthenticated PING.');
  if (!text.includes('NOAUTH')) refuse('Refusing: Redis did not prove authentication.');
}

export function assertPinnedCatalogCommand(args) {
  const banned = ['stop', 'rm', 'kill', 'down', 'restart', 'pg_dumpall', 'FLUSHALL', 'FLUSHDB'];
  if (args.some((arg) => banned.includes(arg)) || args.join(' ').includes('--create')) {
    refuse('Refusing: catalog command is not pinned to the shared StageFlow database.');
  }
  if (args[0] !== 'docker' || args[1] !== 'exec' || args[2] !== '-i') {
    refuse('Refusing: catalog command must exec inside the existing shared PostgreSQL container.');
  }
  if (args[3] !== SHARED_POSTGRES_CONTAINER) {
    refuse('Refusing: catalog command must use shared-postgres.');
  }
  const databaseFlag = args.indexOf('-d');
  const roleFlag = args.indexOf('-U');
  if (args[databaseFlag + 1] !== SHARED_DATABASE || args[roleFlag + 1] !== SHARED_ROLE) {
    refuse('Refusing: catalog command must use stageflow_db and stageflow_app.');
  }
}

export function dedicatedCompose(action) {
  if (action !== 'start' && action !== 'stop') refuse('Use start or stop.');
  const command = [
    'docker',
    'compose',
    '--project-name',
    'stageflow',
    '--env-file',
    '/etc/stageflow/infrastructure.env',
    '-f',
    '/etc/stageflow/compose.yml',
  ];
  if (action === 'start') command.push('up', '-d', '--wait', '--wait-timeout', '90');
  else command.push('stop', '--timeout', '45');
  if (command.includes(SHARED_POSTGRES_CONTAINER) || command.includes(SHARED_REDIS_CONTAINER)) {
    refuse('Refusing: dedicated Compose must not name the shared containers.');
  }
  return command;
}

export function externalStopPlan() {
  return [];
}

export function assertCatalogIdentity(text) {
  const lines = String(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length !== 1) {
    refuse('Refusing: catalog identity was not exactly one row. Nothing was dumped or restored.');
  }
  const [database, role, superuser] = lines[0].split('|');
  if (database !== SHARED_DATABASE || role !== SHARED_ROLE || superuser !== 'f') {
    refuse(
      'Refusing: catalog identity is not stageflow_db owned by non-superuser stageflow_app. Nothing was dumped or restored.',
    );
  }
}

export function assertCatalogPath(file) {
  if (
    typeof file !== 'string' ||
    !file.startsWith('/srv/stageflow/backups/') ||
    file.split('/').includes('..') ||
    file.includes('\0')
  ) {
    refuse('Refusing: catalog path is outside the StageFlow backup directory.');
  }
}

async function readMarker(path) {
  try {
    return { present: true, text: await readFile(path, 'utf8') };
  } catch (error) {
    if (error?.code === 'ENOENT') return { present: false };
    refuse('Refusing: deployment marker could not be read.');
  }
}

export async function modeFromDisk() {
  const external = await readMarker(EXTERNAL_MARKER);
  const fixture = await readMarker(FIXTURE_MARKER);
  return deploymentMode({
    external: external.present ? external.text : undefined,
    fixtureExists: fixture.present,
  });
}

function runCaptured(args) {
  assertPinnedCatalogCommand(args);
  return spawnSync(args[0], args.slice(1), {
    encoding: 'utf8',
    timeout: 10000,
    windowsHide: true,
  });
}

async function requireExternalDumpTarget() {
  if ((await modeFromDisk()) !== 'external') {
    refuse('Refusing: catalog dump and restore require the external-services marker.');
  }
  if (!process.env.DATABASE_URL) refuse('Refusing: DATABASE_URL is missing.');
  assertExternalDatabaseUrl(process.env.DATABASE_URL);
  const identity = runCaptured(identityQueryArgs);
  if (identity.status !== 0) {
    refuse('Refusing: shared catalog identity check failed. Nothing was dumped or restored.');
  }
  assertCatalogIdentity(identity.stdout);
}

function spawnPinned(args, stdio) {
  assertPinnedCatalogCommand(args);
  return spawn(args[0], args.slice(1), { stdio, windowsHide: true });
}

function childFinished(child, streams) {
  return new Promise((resolve, reject) => {
    child.on('error', () =>
      reject(
        new assert.AssertionError({
          message: 'Refusing: catalog command could not start.',
          operator: 'external',
        }),
      ),
    );
    child.on('close', (code) => {
      for (const stream of streams) stream.destroy();
      if (code === 0) resolve();
      else {
        reject(
          new assert.AssertionError({
            message: 'Refusing: pinned catalog command failed. Other databases were not targeted.',
            operator: 'external',
          }),
        );
      }
    });
  });
}

export async function dumpCatalog(file) {
  assertCatalogPath(file);
  await requireExternalDumpTarget();
  const output = createWriteStream(file, { flags: 'w', mode: 0o600 });
  const child = spawnPinned(catalogDumpArgs, ['ignore', 'pipe', 'ignore']);
  child.stdout.pipe(output);
  await childFinished(child, [output]);
}

export async function restoreCatalog(file) {
  assertCatalogPath(file);
  await requireExternalDumpTarget();
  const input = createReadStream(file);
  const child = spawnPinned(catalogRestoreArgs, ['pipe', 'ignore', 'ignore']);
  input.pipe(child.stdin);
  await childFinished(child, [input]);
}

function probeResult(args) {
  const result = spawnSync(args[0], args.slice(1), {
    encoding: 'utf8',
    timeout: 10000,
    windowsHide: true,
  });
  if (result.error || (args[1] === 'inspect' && result.status !== 0)) {
    refuse('Refusing: shared service is not available. StageFlow will not create or restart it.');
  }
  return result;
}

export async function probeSharedServices() {
  if ((await modeFromDisk()) !== 'external') {
    refuse('Refusing: shared-service probe requires the external-services marker.');
  }
  interpretInspect(
    SHARED_POSTGRES_CONTAINER,
    probeResult(inspectArgs(SHARED_POSTGRES_CONTAINER)).stdout,
  );
  interpretInspect(SHARED_REDIS_CONTAINER, probeResult(inspectArgs(SHARED_REDIS_CONTAINER)).stdout);
  const ping = probeResult(redisPingArgs());
  interpretRedisPing(`${ping.stdout ?? ''}\n${ping.stderr ?? ''}`);
}

async function main(action) {
  if (action === 'mode') {
    console.log(await modeFromDisk());
    return;
  }
  if (action === 'probe') {
    await probeSharedServices();
    console.log(
      'Shared PostgreSQL and Redis are running. StageFlow did not start, stop, or recreate them.',
    );
    return;
  }
  if (action === 'dump-catalog') {
    await dumpCatalog(process.argv[3]);
    return;
  }
  if (action === 'restore-catalog') {
    await restoreCatalog(process.argv[3]);
    return;
  }
  refuse('Use mode, probe, dump-catalog, or restore-catalog.');
}

if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  main(process.argv[2]).catch((error) => {
    const message = error instanceof assert.AssertionError ? error.message : '';
    console.error(
      message && !message.includes('://') && !/password|secret/i.test(message)
        ? message
        : 'StageFlow external services check failed. The detail was withheld.',
    );
    process.exitCode = 1;
  });
}
