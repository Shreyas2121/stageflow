import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { devShutdownPath, requestDevShutdown } from './dev-shutdown.mjs';
import { killPid, listDescendantPids } from './dev.mjs';

// Real compiled main/modules, the registered migrations, PostgreSQL, Redis, HTTP, Socket.IO and FFmpeg.
// DATABASE_URL is an administrative connection: only a newly created database is migrated/dropped.
const require = createRequire(new URL('../apps/api/package.json', import.meta.url));
const webRequire = createRequire(new URL('../apps/web/package.json', import.meta.url));
const { Client } = require('pg');
const { Redis } = require('ioredis');
const { io } = webRequire('socket.io-client');
const dist = fileURLToPath(new URL('../apps/api/dist/', import.meta.url));
const id = randomUUID().replaceAll('-', '');
const databaseName = `sf_broadcast_${id}`;
const namespace = `sf_encode_${id}`;
const adminUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
assert(adminUrl && redisUrl, 'DATABASE_URL and REDIS_URL are required.');
const databaseUrl = new URL(adminUrl);
databaseUrl.pathname = `/${databaseName}`;
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const shutdownToken = randomUUID();
const channel = devShutdownPath(randomUUID());
const interrupted = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => interrupted.abort(new Error(`Interrupted by ${signal}`)));
}
const admin = new Client({
  connectionString: adminUrl,
  connectionTimeoutMillis: 3000,
  query_timeout: 5000,
});
const redis = new Redis(redisUrl, {
  lazyConnect: true,
  connectTimeout: 3000,
  commandTimeout: 3000,
  maxRetriesPerRequest: 0,
  retryStrategy: () => null,
});
redis.on('error', () => {}); // connect/ping and all operations are awaited below.
const clients = [];
let root,
  created = false,
  dataSource,
  api,
  address,
  env;
const foreignKey = `${namespace}_foreign:room:sentinel`;

async function killTree(child) {
  if (!child.pid) return;
  if (process.platform !== 'win32') {
    // Every spawned process leads its own group; also reap encoders after an unexpected API exit.
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
    return;
  }
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    await new Promise((done) =>
      execFile('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true }, done),
    );
  }
}

async function command(binary, args, timeout = 30_000) {
  interrupted.signal.throwIfAborted();
  const child = spawn(binary, args, {
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (bytes) => {
    output = (output + bytes).slice(-20_000);
  });
  child.stderr.on('data', (bytes) => {
    output = (output + bytes).slice(-20_000);
  });
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    void killTree(child);
  }, timeout);
  try {
    await new Promise((done, reject) => {
      child.once('error', reject);
      child.once('close', (code) =>
        code === 0 && !expired
          ? done()
          : reject(
              new Error(
                `${basename(binary)} failed (${code}${expired ? ', timeout' : ''}): ${output}`,
              ),
            ),
      );
    });
    return output;
  } finally {
    clearTimeout(timer);
  }
}

async function eventually(check, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  do {
    interrupted.signal.throwIfAborted();
    if (await check()) return;
    await delay(50, undefined, { signal: interrupted.signal });
  } while (Date.now() < deadline);
  throw new Error('Broadcast smoke condition did not settle before its deadline.');
}

async function freePort() {
  const server = createServer();
  await new Promise((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', done);
  });
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}

async function startApi(binary = ffmpeg) {
  const port = await freePort();
  address = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [join(dist, 'main.js')], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    env: { ...env, PORT: String(port), FFMPEG_PATH: binary },
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (bytes) => {
      output = (output + bytes).slice(-16_000);
    });
  api = { child, output: () => output, done: new Promise((done) => child.once('close', done)) };
  child.on('error', (error) => {
    output += error.message;
  });
  try {
    await eventually(async () => {
      if (child.exitCode !== null) throw new Error(`API exited during bootstrap: ${output}`);
      try {
        return (await fetch(`${address}/api/health/live`, { signal: AbortSignal.timeout(500) })).ok;
      } catch {
        return false;
      }
    });
    assert.equal(
      (await fetch(`${address}/api/health`, { signal: AbortSignal.timeout(3000) })).status,
      200,
    );
  } catch (error) {
    throw new Error(`Real API bootstrap failed: ${output}`, { cause: error });
  }
}

async function stopApi() {
  if (!api) return;
  const current = api;
  const descendants = process.platform === 'win32' ? listDescendantPids(current.child.pid) : [];
  for (const socket of clients.splice(0)) socket.disconnect();
  try {
    if (current.child.exitCode === null && current.child.signalCode === null) {
      await requestDevShutdown(channel, shutdownToken, 3000);
      let timer;
      try {
        await Promise.race([
          current.done,
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('API shutdown timed out')), 15_000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    }
    assert.equal(current.child.exitCode, 0, current.output());
  } finally {
    await killTree(current.child);
    for (const pid of descendants.reverse()) killPid(pid);
    await current.done;
    api = undefined;
  }
}

async function request(path, token, options = {}, status = 200) {
  const response = await fetch(`${address}/api${path}`, {
    ...options,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...options.headers },
    signal: AbortSignal.any([interrupted.signal, AbortSignal.timeout(15_000)]),
  });
  assert.equal(
    response.status,
    status,
    `${options.method || 'GET'} ${path}: ${await response.clone().text()}`,
  );
  return response;
}
async function json(path, token, body) {
  return (
    await request(
      path,
      token,
      body
        ? {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          }
        : {},
      body ? 201 : 200,
    )
  ).json();
}
const ack = (socket, event, payload = {}) => socket.timeout(15_000).emitWithAck(event, payload);
async function hostRoom(token) {
  const room = await json('/rooms', token, { title: 'Isolated encode check', mode: 'WEBINAR' });
  const socket = io(address, {
    auth: { token },
    transports: ['websocket'],
    reconnection: false,
    autoConnect: false,
    forceNew: true,
  });
  clients.push(socket);
  await new Promise((done, reject) => {
    const timer = setTimeout(() => reject(new Error('Socket connection timed out')), 5000);
    socket.once('connect', () => {
      clearTimeout(timer);
      done();
    });
    socket.once('connect_error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.connect();
  });
  assert.equal(
    (
      await ack(socket, 'room:join', {
        roomId: room.id,
        isAudioMuted: false,
        isVideoOff: false,
        isSyntheticBot: false,
      })
    ).ok,
    true,
  );
  return { room, socket };
}

try {
  console.log((await command(ffmpeg, ['-version'])).split(/\r?\n/)[0]);
  root = await mkdtemp(join(tmpdir(), 'stageflow-broadcast-'));
  env = {
    ...process.env,
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    JWT_SECRET: randomUUID(),
    DATABASE_URL: databaseUrl.href,
    REDIS_URL: redisUrl,
    LIVE_NAMESPACE: namespace,
    CORS_ORIGIN: 'http://127.0.0.1',
    DATA_ROOT: root,
    STAGEFLOW_DEV_SHUTDOWN: channel,
    STAGEFLOW_DEV_SHUTDOWN_TOKEN: shutdownToken,
  };
  await admin.connect();
  assert.match(databaseName, /^sf_broadcast_[a-f0-9]{32}$/);
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  created = true;
  process.env.DATABASE_URL = databaseUrl.href;
  dataSource = require(join(dist, 'database/data-source.js')).default;
  dataSource.setOptions({
    extra: { connectionTimeoutMillis: 3000, statement_timeout: 5000, query_timeout: 6000 },
  });
  await dataSource.initialize();
  const migrations = await dataSource.runMigrations();
  const registered = [
    'CreateUsersAndRooms1730332800000',
    'CreateBroadcasts1793577600000',
    'IndexRoomsByHost1793664000000',
    'AddHostCredentials1793923200000',
    'AddGoogleSubject1794009600000',
    'AddBroadcastVisibility1794096000000',
    'AddRoomSchedule1794182400000',
  ];
  assert.deepEqual(
    migrations.map((m) => m.name),
    registered,
  );
  assert.deepEqual(await dataSource.runMigrations(), []);
  console.log(
    `Registered migrations applied: ${registered.join(', ')}; second migration run is empty.`,
  );
  await redis.connect();
  await redis.set(foreignKey, id, 'EX', 300);
  const input = join(root, 'input.webm');
  await command(ffmpeg, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=320x180:rate=24',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=48000',
    '-t',
    '6',
    '-c:v',
    'libvpx',
    '-b:v',
    '300k',
    '-c:a',
    'libopus',
    '-f',
    'webm',
    input,
  ]);
  const bytes = await readFile(input);
  await startApi();
  const guest = await json('/sessions/guest', undefined, { displayName: 'Encode host' });
  assert.equal(
    (await dataSource.query('SELECT id FROM users WHERE id = $1', [guest.userId])).length,
    1,
  );
  const { room, socket } = await hostRoom(guest.token);
  assert.equal((await ack(socket, 'broadcast:start')).ok, true);
  const livePage = await json(`/rooms/${room.slug}/broadcasts`, guest.token);
  const live = livePage.items[0];
  assert.equal(live.status, 'LIVE');
  assert.equal(live.thumbnailUrl, null);
  let sequence = 0;
  for (let offset = 0; offset < bytes.length; offset += 64_000) {
    const body = bytes.subarray(offset, offset + 64_000);
    const options = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'x-chunk-sequence': String(sequence++),
      },
      body,
    };
    await request(`/broadcasts/${live.id}/chunks`, guest.token, options, 204);
    if (offset === 0) await request(`/broadcasts/${live.id}/chunks`, guest.token, options, 204);
  }
  assert.equal((await ack(socket, 'broadcast:stop')).ok, true);
  const ready = await json(`/broadcasts/${live.id}`, guest.token);
  assert.equal(ready.status, 'READY');
  const playlist = await (
    await request(`/broadcasts/${live.id}/hls/index.m3u8`, guest.token)
  ).text();
  assert.match(playlist, /#EXT-X-ENDLIST/);
  const segments = playlist.split(/\r?\n/).filter((line) => line && !line.startsWith('#'));
  assert(segments.length >= 2, playlist);
  for (const segment of segments) {
    assert.match(segment, /^segment\d{6,}\.ts$/);
    const served = Buffer.from(
      await (await request(`/broadcasts/${live.id}/hls/${segment}`, guest.token)).arrayBuffer(),
    );
    assert(served.length > 0);
    assert.deepEqual(served, await readFile(join(root, 'broadcasts', live.id, segment)));
  }
  // Decode actual HLS and verify both streams, dimensions and duration through FFmpeg itself.
  const decoded = await command(ffmpeg, [
    '-hide_banner',
    '-i',
    join(root, 'broadcasts', live.id, 'index.m3u8'),
    '-map',
    '0:v:0',
    '-map',
    '0:a:0',
    '-f',
    'null',
    '-',
  ]);
  assert.match(decoded, /Video: h264/);
  assert.match(decoded, /1280x720/);
  assert.match(decoded, /Audio: aac/);
  const lastTime = [...decoded.matchAll(/time=(\d+):(\d+):(\d+\.\d+)/g)].at(-1);
  assert(lastTime, decoded);
  const duration = Number(lastTime[1]) * 3600 + Number(lastTime[2]) * 60 + Number(lastTime[3]);
  assert(duration >= 5.8 && duration <= 6.3, `Decoded duration ${duration}s`);
  assert.equal(await redis.get(`${namespace}:room:${room.id}:broadcast`), null);
  console.log(
    `Real WebM -> HLS passed: ${sequence} chunks, ${segments.length} segments, video/audio decoded, ENDLIST and READY.`,
  );
  await stopApi();
  assert.equal(await redis.get(`${namespace}:owner`), null);

  // One READY recording is inside the guest allowance, so a missing binary still creates a row.
  await startApi(join(root, 'missing-ffmpeg'));
  const missing = await hostRoom(guest.token);
  const unavailable = await ack(missing.socket, 'broadcast:start');
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.error, 'ffmpeg_unavailable');
  assert.equal(unavailable.message, 'FFmpeg is not available. The stage is still up.');
  const failedPage = await json(`/rooms/${missing.room.slug}/broadcasts`, guest.token);
  const failed = failedPage.items[0];
  assert.equal(failed.status, 'FAILED');
  assert.equal(failed.thumbnailUrl, null);
  assert.match(failed.errorMessage, /missing-ffmpeg/);
  assert.equal((await ack(missing.socket, 'media:state', { isAudioMuted: true })).ok, true);
  assert.equal(await redis.get(`${namespace}:room:${missing.room.id}:broadcast`), null);
  assert.equal((await json(`/broadcasts/${ready.id}`, guest.token)).status, 'READY');
  await stopApi();
  assert.equal(await redis.get(`${namespace}:owner`), null);

  // Simulate persisted attempts left by a previous process, without killing an encoder.
  const pendingIds = [];
  for (const status of ['STARTING', 'LIVE', 'STOPPING']) {
    const pendingId = randomUUID();
    pendingIds.push(pendingId);
    await dataSource.query('INSERT INTO broadcasts (id, room_id, status) VALUES ($1, $2, $3)', [
      pendingId,
      room.id,
      status,
    ]);
  }
  await redis.set(`${namespace}:room:${room.id}:broadcast`, pendingIds[0]);
  await startApi();
  for (const pendingId of pendingIds) {
    assert.equal((await json(`/broadcasts/${pendingId}`, guest.token)).status, 'FAILED');
    assert.equal(
      (await json(`/broadcasts/${pendingId}`, guest.token)).errorMessage,
      'api restarted',
    );
  }
  assert.equal((await json(`/broadcasts/${ready.id}`, guest.token)).status, 'READY');
  assert.equal(
    await (await request(`/broadcasts/${ready.id}/hls/index.m3u8`, guest.token)).text(),
    playlist,
  );
  assert.equal(await redis.get(`${namespace}:room:${room.id}:broadcast`), null);
  assert.equal(await redis.get(foreignKey), id);
  assert.equal((await stat(join(root, 'broadcasts', ready.id, 'index.m3u8'))).isFile(), true);
  assert.match(
    (await json(`/broadcasts/${failed.id}`, guest.token)).errorMessage,
    /missing-ffmpeg/,
  );

  // READY, the missing-binary row, and the three restarted rows are past the guest allowance of 3.
  const blocked = await hostRoom(guest.token);
  const full = await ack(blocked.socket, 'broadcast:start');
  assert.equal(full.ok, false);
  assert.equal(full.error, 'storage_full');
  assert.equal(full.message, 'Recording storage is full. Try again shortly.');
  assert.deepEqual((await json(`/rooms/${blocked.room.slug}/broadcasts`, guest.token)).items, []);
  assert.equal(
    (await dataSource.query('SELECT id FROM broadcasts WHERE room_id = $1', [blocked.room.id]))
      .length,
    0,
  );
  assert.equal((await ack(blocked.socket, 'media:state', { isAudioMuted: true })).ok, true);
  assert.equal(await redis.get(`${namespace}:room:${blocked.room.id}:broadcast`), null);
  assert.equal((await json(`/broadcasts/${ready.id}`, guest.token)).status, 'READY');
  assert.equal(
    await (await request(`/broadcasts/${ready.id}/hls/index.m3u8`, guest.token)).text(),
    playlist,
  );
  assert.match(
    (await json(`/broadcasts/${failed.id}`, guest.token)).errorMessage,
    /missing-ffmpeg/,
  );
  await stopApi();
  console.log(
    'Restart fails only in-flight rows, preserves READY/media and foreign namespace; missing binary fails the attempt while stage commands remain usable; a guest past the recording allowance is refused before a row is stored.',
  );
} finally {
  try {
    await stopApi();
  } finally {
    try {
      if (redis.status === 'ready') {
        let cursor = '0';
        do {
          const [next, keys] = await redis.scan(cursor, 'MATCH', `${namespace}:*`, 'COUNT', 100);
          cursor = next;
          assert(keys.every((key) => key.startsWith(`${namespace}:`)));
          if (keys.length) await redis.del(...keys);
        } while (cursor !== '0');
        await redis.del(foreignKey);
      }
    } finally {
      redis.disconnect();
      try {
        if (dataSource?.isInitialized) await dataSource.destroy();
      } finally {
        try {
          if (created) await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
        } finally {
          try {
            await admin.end();
          } finally {
            if (root) {
              assert.equal(dirname(resolve(root)), resolve(tmpdir()));
              assert(basename(root).startsWith('stageflow-broadcast-'));
              await rm(root, { recursive: true, force: true });
            }
            if (process.platform !== 'win32') await rm(channel, { force: true });
          }
        }
      }
    }
  }
}
console.log(
  'Broadcast integration passed; owned API processes, database, Redis keys and media fixture cleaned up.',
);
