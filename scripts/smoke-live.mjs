import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

// No API/Nest bootstrap, migrations, LiveConnection.open(), or database connection.
// The real session verifier uses an in-memory user repository; catalog failures
// are injected here. Redis Lua, gateway handlers, JWTs, and Socket.IO are real.
assert(process.env.REDIS_URL?.trim(), 'REDIS_URL is required for the live smoke test.');
process.env.JWT_SECRET = `smoke-${randomUUID()}`;
process.env.DATABASE_URL = 'postgresql://unused:unused@127.0.0.1:1/unused';
process.env.CORS_ORIGIN = 'http://127.0.0.1';
process.env.LIVE_NAMESPACE = 'sf_smoke';
process.env.SOCKET_EVENT_RATE_LIMIT = '16';
const require = createRequire(new URL('../apps/api/package.json', import.meta.url));
const webRequire = createRequire(new URL('../apps/web/package.json', import.meta.url));
const { Redis } = require('ioredis');
const { Server } = require('socket.io');
const { io } = webRequire('socket.io-client');
const { JwtService } = require('@nestjs/jwt');
const dist = fileURLToPath(new URL('../apps/api/dist/', import.meta.url));
const { SessionsService } = require(`${dist}sessions/sessions.service.js`);
const { SignalingGateway } = require(`${dist}live/signaling.gateway.js`);
const { LiveService } = require(`${dist}live/live.service.js`);
const { LiveRepository } = require(`${dist}live/live.repository.js`);
const { SerializedOperations } = require(`${dist}live/serialized-operations.js`);
const { socketOptions } = require(`${dist}live/socket-options.js`);
const { liveKeys, roomPrefix } = require(`${dist}live/live.keys.js`);
const namespace = `sf:itest:smoke:${randomUUID()}`;
const redis = new Redis(process.env.REDIS_URL, {
  lazyConnect: true,
  connectTimeout: 1500,
  maxRetriesPerRequest: 0,
  retryStrategy: () => null,
});
redis.on('error', () => {}); // Connection failures are asserted by connect/ping below.
const http = createServer();
const server = new Server(http, socketOptions);
const clients = [];
const roomIds = [];
let gateway;

function once(socket, event) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off(event, done);
      reject(new Error(`Timed out waiting for ${event}.`));
    }, 3000);
    function done(value) {
      clearTimeout(timeout);
      resolve(value);
    }
    socket.once(event, done);
  });
}
async function eventually(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await predicate()) return;
    await delay(20);
  }
  assert.fail('Live state did not settle.');
}

try {
  await redis.connect();
  assert.equal(await redis.ping(), 'PONG');
  const users = new Map();
  const jwt = new JwtService({
    secret: process.env.JWT_SECRET,
    signOptions: { algorithm: 'HS256', expiresIn: '5m' },
  });
  const sessions = new SessionsService({ findOneBy: async ({ id }) => users.get(id) ?? null }, jwt);
  const host = { id: randomUUID(), displayName: 'Smoke host' };
  const guest = { id: randomUUID(), displayName: 'Smoke guest' };
  users.set(host.id, host);
  users.set(guest.id, guest);
  const rooms = new Map();
  let failEnd = false;
  const live = new LiveService(
    {
      getById: async (id) => rooms.get(id) ?? null,
      end: async (id) => {
        if (failEnd) {
          failEnd = false;
          throw new Error('Expected smoke catalog failure');
        }
        rooms.get(id).status = 'ENDED';
      },
    },
    new LiveRepository(redis),
    new SerializedOperations(),
    { isReady: () => true },
    namespace,
  );
  gateway = new SignalingGateway(sessions, live, { whenLost: () => {} });
  gateway.server = server;
  gateway.afterInit(server);
  server.on('connection', (socket) => {
    gateway.handleConnection(socket);
    for (const [event, method] of [
      ['room:join', 'join'],
      ['room:leave', 'leave'],
      ['media:state', 'media'],
      ['stage:raise-hand', 'hand'],
      ['webrtc:description', 'description'],
      ['webrtc:ice-candidate', 'iceCandidate'],
    ]) {
      socket.on(event, (payload, ack) => {
        Promise.resolve(gateway[method](socket, payload))
          .then(ack)
          .catch((error) => ack({ ok: false, error: error.message }));
      });
    }
    socket.on('disconnect', () => gateway.handleDisconnect(socket));
  });
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  const address = `http://127.0.0.1:${http.address().port}`;
  function client(token, origin) {
    const socket = io(address, {
      auth: { token },
      autoConnect: false,
      reconnection: false,
      transports: ['websocket'],
      forceNew: true,
      ...(origin ? { extraHeaders: { Origin: origin } } : {}),
    });
    clients.push(socket);
    return socket;
  }
  async function connect(user) {
    const socket = client(await jwt.signAsync({ sub: user.id }));
    const connected = once(socket, 'connect');
    socket.connect();
    await connected;
    return socket;
  }
  const rejected = client('invalid-token');
  const denied = once(rejected, 'connect_error');
  rejected.connect();
  await denied;
  assert.equal(rejected.connected, false);
  const wrongOrigin = client(await jwt.signAsync({ sub: host.id }), 'http://other.invalid');
  const originDenied = once(wrongOrigin, 'connect_error');
  wrongOrigin.connect();
  await originDenied;
  assert.equal(wrongOrigin.connected, false);
  const missingUser = client(await jwt.signAsync({ sub: randomUUID() }));
  const missingDenied = once(missingUser, 'connect_error');
  missingUser.connect();
  await missingDenied;
  const hostSocket = await connect(host),
    guestSocket = await connect(guest);
  const command = (socket, event, payload = {}) => socket.timeout(3000).emitWithAck(event, payload);
  function room(mode) {
    const room = { id: randomUUID(), hostId: host.id, mode, status: 'LIVE' };
    rooms.set(room.id, room);
    roomIds.push(room.id);
    return room;
  }
  const meeting = room('MEETING');
  const join = (socket, room, flags = {}) =>
    command(socket, 'room:join', {
      roomId: room.id,
      isAudioMuted: true,
      isVideoOff: true,
      isSyntheticBot: false,
      ...flags,
    });
  assert.equal((await command(hostSocket, 'room:join', {})).error, 'invalid_payload');
  assert.equal((await join(guestSocket, meeting)).error, 'host_not_present');
  assert.equal((await join(hostSocket, meeting)).ok, true);
  assert.equal((await join(guestSocket, meeting)).ok, true);
  assert.equal(
    (
      await command(hostSocket, 'media:state', {
        isAudioMuted: false,
        isVideoOff: false,
        isScreenSharing: true,
      })
    ).ok,
    true,
  );
  const hostMedia = JSON.parse(
    await redis.hget(`${roomPrefix(meeting.id, namespace)}:participants`, hostSocket.id),
  );
  assert.equal(hostMedia.isAudioMuted, false);
  assert.equal(hostMedia.isVideoOff, false);
  assert.equal(hostMedia.isScreenSharing, true);
  assert.equal((await command(hostSocket, 'media:state', { isScreenSharing: false })).ok, true);
  const description = {
    toSocketId: guestSocket.id,
    description: { type: 'offer', sdp: 'v=0\r\n' },
  };
  const relay = once(guestSocket, 'webrtc:description');
  assert.equal((await command(hostSocket, 'webrtc:description', description)).ok, true);
  assert.equal((await relay).fromSocketId, hostSocket.id);
  const ice = once(guestSocket, 'webrtc:ice-candidate');
  assert.equal(
    (
      await command(hostSocket, 'webrtc:ice-candidate', {
        toSocketId: guestSocket.id,
        candidate: null,
      })
    ).ok,
    true,
  );
  assert.equal((await ice).candidate, null);
  const guestId = guestSocket.id;
  guestSocket.disconnect();
  await eventually(
    async () =>
      !(await redis.hexists(`${roomPrefix(meeting.id, namespace)}:participants`, guestId)),
  );
  const replacement = await connect(guest);
  assert.equal((await join(replacement, meeting)).ok, true);
  failEnd = true;
  assert.equal((await command(hostSocket, 'room:leave')).error, 'server_error');
  assert.equal(meeting.status, 'LIVE');
  const late = await connect({ ...guest, id: host.id });
  assert.equal((await join(late, meeting)).error, 'room_ended');
  late.disconnect();
  const ended = once(replacement, 'room:ended');
  assert.equal((await command(hostSocket, 'room:leave')).ok, true);
  await ended;
  assert.equal(meeting.status, 'ENDED');
  assert.equal(await redis.exists(...liveKeys(roomPrefix(meeting.id, namespace))), 0);
  const webinar = room('WEBINAR');
  assert.equal((await join(hostSocket, webinar)).ok, true);
  assert.equal(
    (
      await join(replacement, webinar, {
        isAudioMuted: false,
        isVideoOff: false,
        isSyntheticBot: true,
      })
    ).ok,
    true,
  );
  assert.equal((await command(replacement, 'stage:raise-hand', { raised: true })).ok, true);
  const attendeeKey = `${roomPrefix(webinar.id, namespace)}:participants`;
  const attendeeBefore = await redis.hget(attendeeKey, replacement.id);
  const attendee = JSON.parse(attendeeBefore);
  assert.equal(attendee.role, 'ATTENDEE');
  assert.equal(attendee.isAudioMuted, true);
  assert.equal(attendee.isVideoOff, true);
  assert.equal(attendee.isScreenSharing, false);
  assert.equal(attendee.isSyntheticBot, true);
  assert.equal(attendee.isHandRaised, true);
  const revisionBefore = await redis.get(`${roomPrefix(webinar.id, namespace)}:rev`);
  for (const patch of [
    { isAudioMuted: false },
    { isVideoOff: false },
    { isScreenSharing: true },
    { isAudioMuted: true, isVideoOff: false, isScreenSharing: false },
  ]) {
    assert.equal((await command(replacement, 'media:state', patch)).error, 'not_on_stage');
    assert.equal(await redis.hget(attendeeKey, replacement.id), attendeeBefore);
    assert.equal(await redis.get(`${roomPrefix(webinar.id, namespace)}:rev`), revisionBefore);
  }
  for (const patch of [{}, { isAudioMuted: true, isVideoOff: true, isScreenSharing: false }]) {
    assert.equal((await command(replacement, 'media:state', patch)).ok, true);
    assert.equal(await redis.hget(attendeeKey, replacement.id), attendeeBefore);
    assert.equal(await redis.get(`${roomPrefix(webinar.id, namespace)}:rev`), revisionBefore);
  }
  assert.deepEqual(await redis.smembers(`${roomPrefix(webinar.id, namespace)}:stage`), [
    hostSocket.id,
  ]);
  assert.equal(
    (
      await command(replacement, 'webrtc:description', {
        toSocketId: hostSocket.id,
        description: description.description,
      })
    ).error,
    'not_on_stage',
  );
  assert.equal((await command(replacement, 'room:leave')).ok, true);
  const webinarId = hostSocket.id;
  hostSocket.disconnect();
  await eventually(() => webinar.status === 'ENDED');
  assert.equal(await redis.exists(...liveKeys(roomPrefix(webinar.id, namespace))), 0);
  assert.equal(server.sockets.sockets.get(webinarId), undefined);
  const burst = await Promise.all(
    Array.from({ length: 32 }, () => command(replacement, 'room:join', {})),
  );
  assert(burst.some((result) => result.error === 'rate_limited'));
  assert.equal((await command(replacement, 'room:leave')).ok, true);
  const oversized = await connect(guest);
  const oversizedClosed = once(oversized, 'disconnect');
  oversized.emit('room:join', { padding: 'x'.repeat(socketOptions.maxHttpBufferSize + 1) });
  await oversizedClosed;
  console.log(
    'Live smoke passed: JWT/origin rejection, normalized attendee flags and no-op revisions, rejected off-stage activation/relay, ordinary stage media/ICE, disconnect/rejoin, shutdown retry, event budgets, and cleanup.',
  );
} finally {
  gateway?.onModuleDestroy();
  for (const socket of clients) socket.disconnect();
  await new Promise((resolve) => server.close(resolve));
  if (http.listening) await new Promise((resolve) => http.close(resolve));
  try {
    if (redis.status === 'ready')
      for (const id of roomIds) await redis.del(...liveKeys(roomPrefix(id, namespace)));
  } finally {
    redis.disconnect();
  }
}
