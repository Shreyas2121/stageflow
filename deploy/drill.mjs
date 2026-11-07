// Destructive to fixture state only. Never install the fixture marker on a real host.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFile, readdir, rename, writeFile, unlink } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { join } from 'node:path';

assert.equal(await readFile('/etc/stageflow/fixture-only', 'utf8'), 'sf-c12-disposable');
assert.equal(process.env.CORS_ORIGIN, 'https://stageflow.test');
const require = createRequire(new URL('../apps/api/package.json', import.meta.url));
const webRequire = createRequire(new URL('../apps/web/package.json', import.meta.url));
const { Redis } = require('ioredis');
const { Client } = require('pg');
const { io } = webRequire('socket.io-client');
const redis = new Redis(process.env.REDIS_URL);
redis.on('error', () => {});
const database = new Client({ connectionString: process.env.DATABASE_URL });
const origin = process.env.CORS_ORIGIN;
const namespace = process.env.LIVE_NAMESPACE;
const node = process.execPath;
const run = (binary, args, timeout = 90000) =>
  execFileSync(binary, args, { encoding: 'utf8', timeout, stdio: ['pipe', 'pipe', 'pipe'] });
const unit = (...args) => run('systemctl', args);
const resetFailed = () => {
  if (unit('show', 'stageflow', '--property=ActiveState', '--value').trim() === 'failed')
    unit('reset-failed', 'stageflow');
};
const wait = async (check, milliseconds = 15000) => {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error('Fixture deadline exceeded.');
};
const request = async (path, token, body, status = body ? 201 : 200) => {
  const response = await fetch(origin + '/api' + path, {
    method: body ? 'POST' : 'GET',
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  assert.equal(response.status, status, `${path}: unexpected status`);
  return response;
};
const json = async (...args) => (await request(...args)).json();
const ack = (socket, event, payload = {}) => socket.timeout(15000).emitWithAck(event, payload);
const ownerKey = `${namespace}:owner`;
let socket;

try {
  unit('start', 'stageflow-infra');
  await database.connect();
  unit('start', 'stageflow-migrate');
  unit('start', 'stageflow-migrate');
  unit('start', 'nginx', 'stageflow');
  run('nginx', ['-t']);
  unit('reload-or-restart', 'nginx');
  await wait(async () => {
    try {
      return (await fetch('http://127.0.0.1:4100/api/health/live')).ok;
    } catch {
      return false;
    }
  });
  const page = await fetch(origin + '/r/fixture');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.equal(
    (await fetch(origin + '/api/health')).headers.get('cache-control'),
    'private, no-store',
  );
  assert.equal(
    (await fetch(origin + '/api/health', { headers: { Origin: 'https://foreign.test' } })).status,
    403,
  );
  assert.equal((await fetch(origin + '/media/broadcasts/hidden')).status, 404);
  await fetch(origin + '/api/sessions/google/callback?code=c12-query-secret&state=fixture', {
    redirect: 'manual',
  });
  assert(
    !(await readFile('/var/log/stageflow-nginx/access.log', 'utf8')).includes('c12-query-secret'),
  );
  const html = await page.text();
  const asset = html.match(/src="([^"]+\.js)"/)[1];
  assert.match((await fetch(origin + asset)).headers.get('cache-control'), /immutable/);

  const owner = await json('/sessions/register', undefined, {
    displayName: 'Restore owner',
    email: `restore-${Date.now()}@example.test`,
    password: 'fixture-only-password-123',
  });
  const other = await json('/sessions/guest', undefined, { displayName: 'Other member' });
  const room = await json('/rooms', owner.token, {
    title: 'Production fixture replay',
    mode: 'WEBINAR',
  });
  socket = io(origin, {
    auth: { token: owner.token },
    transports: ['websocket'],
    extraHeaders: { Origin: origin },
    reconnection: false,
  });
  await new Promise((done, reject) => {
    socket.once('connect', done);
    socket.once('connect_error', reject);
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
  assert.equal((await ack(socket, 'qa:submit', { text: 'Production ingress question' })).ok, true);
  assert.equal((await ack(socket, 'broadcast:start')).ok, true);
  assert.equal((await ack(socket, 'broadcast:start')).ok, false);
  const live = (await json(`/rooms/${room.slug}/broadcasts`, owner.token)).items[0];
  run('/usr/bin/ffmpeg', [
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
    '/tmp/stageflow-fixture.webm',
  ]);
  const input = await readFile('/tmp/stageflow-fixture.webm');
  const uploadStarted = performance.now();
  for (let offset = 0, sequence = 0; offset < input.length; offset += 64000, sequence++) {
    const response = await fetch(`${origin}/api/broadcasts/${live.id}/chunks`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${owner.token}`,
        'Content-Type': 'application/octet-stream',
        'x-chunk-sequence': String(sequence),
      },
      body: input.subarray(offset, offset + 64000),
      signal: AbortSignal.timeout(15000),
    });
    assert.equal(response.status, 204);
    // Model six seconds of live browser input instead of bursting an entire
    // recording into a CPU-limited encoder just before its bounded stop window.
    const due = (Math.min(offset + 64000, input.length) / input.length) * 6000;
    const remaining = due - (performance.now() - uploadStarted);
    if (remaining > 0) await new Promise((done) => setTimeout(done, remaining));
  }
  assert.equal((await ack(socket, 'broadcast:stop')).ok, true);
  assert.equal((await json(`/broadcasts/${live.id}`, owner.token)).status, 'READY');
  const playlistPath = `/broadcasts/${live.id}/hls/index.m3u8`;
  assert.match(await (await request(playlistPath, owner.token)).text(), /ENDLIST/);
  assert.equal(
    (await request(`/broadcasts/${live.id}/visibility`, owner.token, { visibility: 'HOST' }, 200))
      .status,
    200,
  );
  await request(playlistPath, other.token, undefined, 404);
  const latencies = [];
  for (let i = 0; i < 20; i++) {
    const start = performance.now();
    await request('/health');
    latencies.push(performance.now() - start);
  }
  latencies.sort((a, b) => a - b);
  console.log(
    JSON.stringify({
      fixtureOnly: true,
      sequentialHealthP95Ms: latencies[18],
      resourceCounters: unit(
        'show',
        'stageflow',
        '--property=CPUUsageNSec,MemoryCurrent,MemoryPeak,TasksCurrent,CPUQuotaPerSecUSec,MemoryMax,TasksMax',
      )
        .trim()
        .split('\n'),
    }),
  );
  console.log(
    'TLS/WSS, SPA, CSP, caching, origin rejection, Q&A, real recording, HOST replay privacy passed.',
  );

  // Check graceful process-tree cleanup while an actual encoder is alive.
  assert.equal((await ack(socket, 'broadcast:start')).ok, true);
  const children = run('pgrep', ['-u', 'stageflow', '-x', 'ffmpeg']).trim().split('\n');
  unit('stop', 'stageflow');
  socket.disconnect();
  assert.equal(await redis.get(ownerKey), null);
  for (const pid of children) {
    assert.throws(() => run('kill', ['-0', pid]), 'Encoder survived unit stop.');
  }
  console.log('SIGTERM unit stop released the owner and reaped the encoder process tree.');

  resetFailed();
  unit('start', 'stageflow');
  await wait(async () => {
    try {
      return (await fetch('http://127.0.0.1:4100/api/health/live')).ok;
    } catch {
      return false;
    }
  });
  const old = await redis.get(ownerKey);
  await redis.set(`${namespace}:room:fixture:sentinel`, 'preserve-until-owned');
  unit('kill', '--kill-whom=main', '--signal=SIGKILL', 'stageflow');
  unit('stop', 'stageflow');
  assert.equal(await redis.get(ownerKey), old);
  resetFailed();
  unit('start', 'stageflow');
  await wait(
    async () =>
      unit('show', 'stageflow', '--property=ActiveState', '--value').trim() === 'activating',
  );
  unit('stop', 'stageflow');
  assert.equal(await redis.get(`${namespace}:room:fixture:sentinel`), 'preserve-until-owned');
  const recover = (token) =>
    run(node, [
      '--env-file=/etc/stageflow/stageflow.env',
      '/opt/stageflow/current/deploy/ops.mjs',
      'recover-guard',
      '--fenced',
      token,
    ]);
  assert.throws(() => recover('999:11111111-1111-4111-8111-111111111111'));
  assert.equal(await redis.get(ownerKey), old);
  recover(old);
  assert.equal(await redis.get(`${namespace}:room:fixture:sentinel`), 'preserve-until-owned');
  resetFailed();
  unit('start', 'stageflow');
  await wait(async () => {
    try {
      return (await fetch('http://127.0.0.1:4100/api/health/live')).ok;
    } catch {
      return false;
    }
  });
  assert.equal(await redis.get(`${namespace}:room:fixture:sentinel`), null);
  console.log(
    'Crash restart failed closed; wrong-token recovery preserved guard; fenced compare-delete and one replacement passed.',
  );

  const redisOwner = await redis.get(ownerKey);
  const compose = (...args) =>
    run('docker', [
      'compose',
      '-p',
      'stageflow',
      '--env-file',
      '/etc/stageflow/infrastructure.env',
      '-f',
      '/etc/stageflow/compose.yml',
      ...args,
    ]);
  compose('stop', 'redis');
  await wait(async () => unit('show', 'stageflow', '--property=MainPID', '--value').trim() === '0');
  unit('stop', 'stageflow');
  compose('start', 'redis');
  await wait(async () => redis.status === 'ready');
  assert.equal(await redis.get(ownerKey), redisOwner);
  recover(redisOwner);
  resetFailed();
  unit('start', 'stageflow');
  await wait(async () => {
    try {
      return (await fetch('http://127.0.0.1:4100/api/health/live')).ok;
    } catch {
      return false;
    }
  });
  console.log(
    'Redis loss exited the writer; AOF retained fencing and explicit stopped-owner recovery passed.',
  );

  unit('start', 'stageflow-health');
  assert.throws(() => run('sh', ['deploy/backup.sh']), 'Backup accepted a live writer.');
  unit('stop', 'stageflow');
  run('sh', ['deploy/backup.sh']);
  const snapshots = (await readdir('/srv/stageflow/backups')).filter((name) =>
    /^\d{8}T\d{6}Z-/.test(name),
  );
  const snapshot = join('/srv/stageflow/backups', snapshots.sort().at(-1));
  assert.throws(
    () => run('sh', ['deploy/restore.sh', '--confirm-offline-restore', snapshot]),
    'Restore accepted nonempty media.',
  );
  await database.query("UPDATE broadcasts SET status = 'FAILED' WHERE id = $1", [live.id]);
  await rename('/srv/stageflow/media', `/srv/stageflow/media-before-restore-${Date.now()}`);
  run('install', [
    '-d',
    '-m',
    '0700',
    '-o',
    'stageflow',
    '-g',
    'stageflow',
    '/srv/stageflow/media',
  ]);
  run('sh', ['deploy/restore.sh', '--confirm-offline-restore', snapshot]);
  resetFailed();
  unit('start', 'stageflow');
  await wait(async () => {
    try {
      return (await fetch('http://127.0.0.1:4100/api/health/live')).ok;
    } catch {
      return false;
    }
  });
  assert.equal((await json(`/broadcasts/${live.id}`, owner.token)).status, 'READY');
  const restoredPlaylist = await (await request(playlistPath, owner.token)).text();
  assert.match(restoredPlaylist, /ENDLIST/);
  await request(playlistPath, other.token, undefined, 404);
  for (const name of restoredPlaylist.split('\n').filter((line) => line.endsWith('.ts'))) {
    const response = await request(`/broadcasts/${live.id}/hls/${name}`, owner.token);
    assert((await response.arrayBuffer()).byteLength > 0);
  }
  run('/usr/bin/ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    `/srv/stageflow/media/broadcasts/${live.id}/index.m3u8`,
    '-map',
    '0:v:0',
    '-map',
    '0:a:0',
    '-f',
    'null',
    '-',
  ]);
  console.log(
    'Offline backup/restore preserved READY audio/video and owner-only HTTP playback; other account remains denied.',
  );
  run('install', [
    '-d',
    '/srv/stageflow/pressure',
    '/etc/systemd/system/stageflow-health.service.d',
  ]);
  run('mount', ['-t', 'tmpfs', '-o', 'size=16m', 'tmpfs', '/srv/stageflow/pressure']);
  await writeFile(
    '/etc/stageflow/pressure.env',
    'DATA_ROOT=/srv/stageflow/pressure\nMIN_FREE_BYTES=2147483648\n',
    { mode: 0o600 },
  );
  await writeFile(
    '/etc/systemd/system/stageflow-health.service.d/pressure.conf',
    '[Service]\nEnvironmentFile=/etc/stageflow/pressure.env\n',
  );
  unit('daemon-reload');
  assert.throws(() => unit('start', 'stageflow-health'));
  await wait(async () =>
    run('journalctl', ['--namespace=stageflow', '-t', 'stageflow-alert', '--no-pager']).includes(
      'stageflow-health.service failed',
    ),
  );
  await unlink('/etc/systemd/system/stageflow-health.service.d/pressure.conf');
  await unlink('/etc/stageflow/pressure.env');
  run('umount', ['/srv/stageflow/pressure']);
  unit('daemon-reload');
  unit('reset-failed', 'stageflow-health');
  unit('start', 'stageflow-health');
  console.log(
    'A real low-free-space tmpfs failed health, invoked OnFailure journal alert, then recovered.',
  );
  unit('start', 'stageflow-alert@fixture');
  assert.match(
    run('journalctl', ['--namespace=stageflow', '-t', 'stageflow-alert', '--no-pager']),
    /fixture/,
  );
  console.log(
    'Local journal alert drill passed. Remote alert routing, TURN, browser playback and target load remain unverified.',
  );
} finally {
  socket?.disconnect();
  redis.disconnect();
  await database.end();
}
