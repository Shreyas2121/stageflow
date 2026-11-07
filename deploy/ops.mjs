import assert from 'node:assert/strict';
import { access, readFile, statfs } from 'node:fs/promises';
import { constants, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertExternalRuntime, modeFromDisk } from './external.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(new URL('../apps/api/package.json', import.meta.url));

export function applyStartupChecks(env, mode) {
  checkProfile(env);
  if (mode === 'external') assertExternalRuntime(env);
}

export function checkProfile(env) {
  assert.equal(env.NODE_ENV, 'production', 'Production NODE_ENV required.');
  assert.equal(env.HOST, '127.0.0.1', 'The API must bind loopback.');
  assert.equal(env.TRUSTED_PROXIES, '127.0.0.1', 'Trust only the local ingress.');
  assert.match(env.CORS_ORIGIN, /^https:\/\/[^/]+$/, 'One exact HTTPS origin required.');
  assert(!env.CORS_ORIGIN.endsWith('.example.com'), 'Replace the example domain.');
  assert(isAbsolute(env.DATA_ROOT), 'Persistent media needs an absolute path.');
  assert(!env.DATA_ROOT.startsWith('/opt/'), 'Media must be outside releases.');
  assert.equal(
    env.DATA_ROOT,
    '/srv/stageflow/media',
    'Match the profile writable/persistent media path.',
  );
  for (const key of ['DATABASE_URL', 'REDIS_URL']) {
    const url = new URL(env[key]);
    assert(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), `${key} must be private.`);
    assert(url.password && !env[key].includes('CHANGE_ME'), `${key} needs a unique secret.`);
  }
  assert(
    env.JWT_SECRET?.length >= 32 && !env.JWT_SECRET.includes('CHANGE_ME'),
    'Replace the JWT secret.',
  );
  assert.equal(env.ENCODER_GLOBAL_LIMIT, '1', 'This profile permits one encoder.');
  assert.equal(env.FFMPEG_THREADS, '1', 'This profile permits one encoder thread.');
}

export async function removeFencedGuard(redis, namespace, expected, state) {
  assert(state.fenced, 'Explicit operator fencing acknowledgement required.');
  assert(['inactive', 'failed'].includes(state.active), 'Stop the writer first.');
  assert.equal(state.pid, '0', 'A service process is still present.');
  assert(!state.job, 'A service start/stop job is pending.');
  assert(!state.populated, 'Service cgroup is still populated.');
  assert.match(namespace, /^[A-Za-z0-9_-]{1,64}$/, 'Use the exact configured namespace.');
  assert.match(expected, /^\d+:[0-9a-f-]{36}$/i, 'Supply the exact observed owner token.');
  const result = await redis.eval(
    "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0",
    1,
    `${namespace}:owner`,
    expected,
  );
  assert.equal(result, 1, 'Owner changed or is absent; nothing was deleted.');
}

async function serviceState() {
  const output = execFileSync(
    'systemctl',
    ['show', 'stageflow.service', '--property=LoadState,ActiveState,MainPID,ControlGroup,Job'],
    { encoding: 'utf8', timeout: 5000 },
  );
  const values = Object.fromEntries(
    output
      .trim()
      .split('\n')
      .map((line) => {
        const index = line.indexOf('=');
        return [line.slice(0, index), line.slice(index + 1)];
      }),
  );
  assert.equal(values.LoadState, 'loaded', 'Expected the installed StageFlow unit.');
  let populated = false;
  if (values.ControlGroup) {
    try {
      populated = /populated 1/.test(
        await readFile(join('/sys/fs/cgroup', values.ControlGroup, 'cgroup.events'), 'utf8'),
      );
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return { active: values.ActiveState, pid: values.MainPID, job: values.Job, populated };
}

async function main(action) {
  const env = process.env;
  if (action === 'check') {
    applyStartupChecks(env, await modeFromDisk());
    require(join(root, 'apps/api/dist/config/parse-config.js')).parseConfig(env);
    await access(env.DATA_ROOT, constants.R_OK | constants.W_OK);
    const ffmpeg = spawnSync(env.FFMPEG_PATH, ['-version'], { encoding: 'utf8', timeout: 5000 });
    assert.equal(ffmpeg.status, 0, 'FFmpeg unavailable to service identity.');
    console.log(ffmpeg.stdout.split('\n')[0]);
    return;
  }
  if (action === 'health') {
    const address = `http://127.0.0.1:${env.PORT}`;
    for (const path of ['/api/health', '/api/health/live']) {
      const response = await fetch(address + path, { signal: AbortSignal.timeout(3000) });
      assert(response.ok, 'Dependency readiness failed.');
    }
    const disk = await statfs(env.DATA_ROOT, { bigint: true });
    assert(disk.bavail * disk.bsize >= BigInt(env.MIN_FREE_BYTES), 'Disk free-space alert.');
    const { Client } = require('pg');
    const database = new Client({
      connectionString: env.DATABASE_URL,
      connectionTimeoutMillis: 3000,
      query_timeout: 3000,
    });
    try {
      await database.connect();
      const { rows } = await database.query(
        'SELECT status, count(*)::int AS count FROM broadcasts GROUP BY status',
      );
      console.log(
        JSON.stringify({
          healthy: true,
          freeBytes: String(disk.bavail * disk.bsize),
          broadcasts: rows,
        }),
      );
    } finally {
      await database.end();
    }
    return;
  }
  if (action === 'recover-guard') {
    assert.equal(process.getuid?.(), 0, 'Recovery requires the local operator.');
    assert.equal(
      process.argv[3],
      '--fenced',
      'Stop/fence all writers, then pass --fenced and the observed token.',
    );
    const state = await serviceState();
    const { Redis } = require('ioredis');
    const redis = new Redis(env.REDIS_URL, {
      lazyConnect: true,
      connectTimeout: 3000,
      commandTimeout: 3000,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
    });
    redis.on('error', () => {});
    try {
      await redis.connect();
      await removeFencedGuard(redis, env.LIVE_NAMESPACE, process.argv[4], {
        ...state,
        fenced: true,
      });
      console.log(
        'Fenced owner token removed; room keys were not touched. Start exactly one writer.',
      );
    } finally {
      redis.disconnect();
    }
    return;
  }
  throw new Error('Use check, health, or recover-guard.');
}

if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  main(process.argv[2]).catch((error) => {
    // Dependency errors can contain connection strings. Do not print raw exceptions.
    console.error(
      error instanceof assert.AssertionError
        ? `StageFlow ${process.argv[2]} refused: ${error.message}`
        : `StageFlow ${process.argv[2]} failed; check protected configuration, service state, dependencies and disk.`,
    );
    process.exitCode = 1;
  });
}
