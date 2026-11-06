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
const { ChatRepository, chatKeys } = require(`${dist}chat/chat.repository.js`);
const { ChatService } = require(`${dist}chat/chat.service.js`);
const { QaRepository, qaKeys } = require(`${dist}qa/qa.repository.js`);
const { QaService } = require(`${dist}qa/qa.service.js`);
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
let live;
let chat;
let qa;

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
  const userRepository = {
    findOneBy: async ({ id }) => users.get(id) ?? null,
    createQueryBuilder: () => {
      let userId;
      const query = {
        addSelect: () => query,
        where: (_sql, values) => {
          userId = values.id;
          return query;
        },
        setLock: () => query,
        getOne: async () => users.get(userId) ?? null,
      };
      return query;
    },
    save: async (user) => {
      users.set(user.id, user);
      return user;
    },
    manager: { transaction: async (work) => work({ getRepository: () => userRepository }) },
  };
  const sessions = new SessionsService(userRepository, jwt);
  const host = { id: randomUUID(), displayName: 'Smoke host', isGuest: true, sessionVersion: 0 };
  const guest = { id: randomUUID(), displayName: 'Smoke guest', isGuest: true, sessionVersion: 0 };
  users.set(host.id, host);
  users.set(guest.id, guest);
  const rooms = new Map();
  let failEnd = false;
  const chatRepository = new ChatRepository(redis);
  const qaRepository = new QaRepository(redis);
  live = new LiveService(
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
    undefined,
    undefined,
    chatRepository,
    qaRepository,
  );
  chat = new ChatService(chatRepository, live, namespace);
  qa = new QaService(qaRepository, live, namespace);
  gateway = new SignalingGateway(sessions, live, { whenLost: () => {} }, chat, qa);
  gateway.server = server;
  gateway.afterInit(server);
  server.on('connection', (socket) => {
    gateway.handleConnection(socket);
    for (const [event, method] of [
      ['room:join', 'join'],
      ['room:resume', 'resume'],
      ['room:leave', 'leave'],
      ['media:state', 'media'],
      ['stage:raise-hand', 'hand'],
      ['webrtc:description', 'description'],
      ['webrtc:ice-candidate', 'iceCandidate'],
      ['chat:send', 'sendChat'],
      ['chat:history', 'chatHistory'],
      ['chat:set-paused', 'setChatPaused'],
      ['qa:submit', 'submitQuestion'],
      ['qa:vote', 'voteQuestion'],
      ['qa:state', 'questionState'],
      ['qa:dismiss', 'dismissQuestion'],
      ['qa:feature', 'featureQuestion'],
      ['qa:clear-feature', 'clearFeaturedQuestion'],
      ['qa:set-submissions', 'setQuestionSubmissions'],
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
  const memberId = (room, socketId) =>
    redis.hget(`${roomPrefix(room.id, namespace)}:transports`, socketId);
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
  const guestJoin = await join(guestSocket, meeting);
  assert.equal(guestJoin.ok, true);
  assert.match(guestJoin.resumeCredential, /^[A-Za-z0-9_-]{43}$/);
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
    await redis.hget(
      `${roomPrefix(meeting.id, namespace)}:participants`,
      await memberId(meeting, hostSocket.id),
    ),
  );
  assert.equal(hostMedia.isAudioMuted, false);
  assert.equal(hostMedia.isVideoOff, false);
  assert.equal(hostMedia.isScreenSharing, true);
  assert.equal((await command(hostSocket, 'media:state', { isScreenSharing: false })).ok, true);
  const description = {
    toParticipantId: await memberId(meeting, guestSocket.id),
    description: { type: 'offer', sdp: 'v=0\r\n' },
  };
  const relay = once(guestSocket, 'webrtc:description');
  assert.equal((await command(hostSocket, 'webrtc:description', description)).ok, true);
  assert.equal((await relay).fromParticipantId, await memberId(meeting, hostSocket.id));
  const ice = once(guestSocket, 'webrtc:ice-candidate');
  assert.equal(
    (
      await command(hostSocket, 'webrtc:ice-candidate', {
        toParticipantId: await memberId(meeting, guestSocket.id),
        candidate: null,
      })
    ).ok,
    true,
  );
  assert.equal((await ice).candidate, null);
  const guestId = await memberId(meeting, guestSocket.id);
  const guestPresence = async () =>
    JSON.parse(await redis.hget(`${roomPrefix(meeting.id, namespace)}:participants`, guestId));
  guestSocket.disconnect();
  await eventually(async () => (await guestPresence())?.presence === 'suspended');
  assert.equal((await guestPresence()).socketId, null);
  assert.equal((await guestPresence()).isAudioMuted, true);
  const resumer = await connect(guest);
  assert.equal((await join(resumer, meeting)).error, 'already_joined');
  assert.equal(
    (
      await command(resumer, 'room:resume', {
        roomId: meeting.id,
        participantId: guestId,
        resumeCredential: 'x'.repeat(43),
      })
    ).error,
    'invalid_resume',
  );
  const resumed = await command(resumer, 'room:resume', {
    roomId: meeting.id,
    participantId: guestId,
    resumeCredential: guestJoin.resumeCredential,
  });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.participantId, guestId);
  assert.equal(resumed.connectionGeneration, 2);
  assert.equal(
    resumed.snapshot.participants.find((p) => p.participantId === guestId).isVideoOff,
    true,
  );
  resumer.disconnect();
  await eventually(async () => (await guestPresence())?.presence === 'suspended');
  assert.equal((await live.expire(meeting.id, Date.now() + 20001)).ok, true);
  assert.equal(
    await redis.hexists(`${roomPrefix(meeting.id, namespace)}:participants`, guestId),
    0,
  );
  assert.equal(await redis.hexists(`${roomPrefix(meeting.id, namespace)}:resume`, guestId), 0);
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
  const attendeeId = await memberId(webinar, replacement.id);
  const attendeeKey = `${roomPrefix(webinar.id, namespace)}:participants`;
  const attendeeBefore = await redis.hget(attendeeKey, attendeeId);
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
    assert.equal(await redis.hget(attendeeKey, attendeeId), attendeeBefore);
    assert.equal(await redis.get(`${roomPrefix(webinar.id, namespace)}:rev`), revisionBefore);
  }
  for (const patch of [{}, { isAudioMuted: true, isVideoOff: true, isScreenSharing: false }]) {
    assert.equal((await command(replacement, 'media:state', patch)).ok, true);
    assert.equal(await redis.hget(attendeeKey, attendeeId), attendeeBefore);
    assert.equal(await redis.get(`${roomPrefix(webinar.id, namespace)}:rev`), revisionBefore);
  }
  assert.deepEqual(await redis.smembers(`${roomPrefix(webinar.id, namespace)}:stage`), [
    await memberId(webinar, hostSocket.id),
  ]);
  assert.equal(
    (
      await command(replacement, 'webrtc:description', {
        toParticipantId: await memberId(webinar, hostSocket.id),
        description: description.description,
      })
    ).error,
    'not_on_stage',
  );
  assert.equal((await command(replacement, 'room:leave')).ok, true);
  const webinarId = hostSocket.id;
  const hostParticipantId = await memberId(webinar, hostSocket.id);
  hostSocket.disconnect();
  await eventually(
    async () =>
      JSON.parse(
        await redis.hget(`${roomPrefix(webinar.id, namespace)}:participants`, hostParticipantId),
      )?.presence === 'suspended',
  );
  assert.equal(webinar.status, 'LIVE');
  assert.equal((await live.expire(webinar.id, Date.now() + 20001)).ok, true);
  assert.equal(webinar.status, 'ENDED');
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

  const ava = { id: randomUUID(), displayName: 'Ava', isGuest: true, sessionVersion: 0 };
  const sam = { id: randomUUID(), displayName: 'Sam', isGuest: true, sessionVersion: 0 };
  users.set(ava.id, ava);
  users.set(sam.id, sam);
  const avaSocket = await connect(ava),
    samSocket = await connect(sam);
  const discussion = room('WEBINAR');
  discussion.hostId = ava.id;
  assert.equal((await join(avaSocket, discussion)).ok, true);
  assert.equal((await join(samSocket, discussion)).ok, true);
  const discussionPrefix = roomPrefix(discussion.id, namespace);
  const stageRevision = await redis.get(`${discussionPrefix}:rev`);
  const avaMessages = [],
    samMessages = [];
  avaSocket.on('chat:message', (message) => avaMessages.push(message));
  samSocket.on('chat:message', (message) => samMessages.push(message));
  const firstLine = await command(avaSocket, 'chat:send', {
    requestId: randomUUID(),
    text: ' Starting now. ',
  });
  assert.equal(firstLine.ok, true);
  assert.equal(firstLine.message.text, 'Starting now.');
  assert.equal(firstLine.message.displayName, 'Ava');
  assert.equal(firstLine.message.role, 'HOST');
  const question = { requestId: randomUUID(), text: 'When do we begin?' };
  const secondLine = await command(samSocket, 'chat:send', question);
  assert.equal(secondLine.ok, true);
  assert.equal(secondLine.message.role, 'ATTENDEE');
  assert.equal(secondLine.message.sequence, firstLine.message.sequence + 1);
  await eventually(() => avaMessages.length === 2 && samMessages.length === 2);
  assert.deepEqual(avaMessages, samMessages);
  const recent = await command(samSocket, 'chat:history');
  assert.equal(recent.ok, true);
  assert.deepEqual(recent.messages, [firstLine.message, secondLine.message]);
  assert.deepEqual(await command(samSocket, 'chat:send', question), secondLine);
  assert.equal(await redis.llen(`${discussionPrefix}:chat:messages`), 2);
  const avaPaused = once(avaSocket, 'chat:paused'),
    samPaused = once(samSocket, 'chat:paused');
  assert.deepEqual(await command(avaSocket, 'chat:set-paused', { paused: true }), {
    ok: true,
    paused: true,
  });
  assert.deepEqual(await avaPaused, { paused: true });
  assert.deepEqual(await samPaused, { paused: true });
  for (const socket of [avaSocket, samSocket])
    assert.equal(
      (await command(socket, 'chat:send', { requestId: randomUUID(), text: 'Paused' })).error,
      'chat_paused',
    );
  assert.equal((await command(samSocket, 'chat:set-paused', { paused: false })).error, 'not_host');
  assert.equal(
    (await command(samSocket, 'chat:send', { ...question, displayName: 'Forged' })).error,
    'invalid_payload',
  );
  assert.equal(
    (await command(samSocket, 'chat:send', { requestId: randomUUID(), text: ' ' })).error,
    'chat_invalid',
  );
  assert.equal((await command(avaSocket, 'chat:set-paused', { paused: false })).ok, true);
  const questionEvent = once(avaSocket, 'qa:state');
  const submitted = await command(samSocket, 'qa:submit', { text: '  Can we ship?  ' });
  assert.equal(submitted.ok, true);
  assert.deepEqual(submitted.votedQuestionIds, []);
  assert.equal(submitted.questions[0].text, 'Can we ship?');
  assert.equal(submitted.questions[0].authorName, 'Sam');
  const publicBoard = await questionEvent;
  assert.equal('votedQuestionIds' in publicBoard, false);
  const questionId = submitted.questions[0].id;
  const voted = await command(avaSocket, 'qa:vote', { questionId });
  assert.equal(voted.ok, true);
  assert.deepEqual(voted.votedQuestionIds, [questionId]);
  assert.equal(voted.questions[0].voteCount, 1);
  assert.deepEqual(await command(avaSocket, 'qa:vote', { questionId }), voted);
  assert.deepEqual((await command(samSocket, 'qa:state')).votedQuestionIds, []);
  assert.equal(
    (await command(samSocket, 'qa:submit', { text: 'Forged', authorName: 'Ava' })).error,
    'invalid_payload',
  );
  const featureEvent = once(samSocket, 'qa:state');
  const featured = await command(avaSocket, 'qa:feature', { questionId });
  assert.deepEqual(featured.featured, { questionId, text: 'Can we ship?', authorName: 'Sam' });
  assert.deepEqual((await featureEvent).featured, featured.featured);
  assert.equal('votedQuestionIds' in (await featureEvent), false);
  const closed = await command(avaSocket, 'qa:set-submissions', { open: false });
  assert.equal(closed.submissionsOpen, false);
  assert.deepEqual(closed.featured, featured.featured);
  assert.equal((await command(avaSocket, 'qa:submit', { text: 'Closed' })).error, 'qa_closed');
  assert.equal((await command(samSocket, 'qa:feature', { questionId })).error, 'not_host');
  for (let i = 0; i < 2; i++)
    assert.equal((await command(avaSocket, 'qa:clear-feature')).featured, null);
  assert.equal((await command(avaSocket, 'qa:feature', { questionId })).ok, true);
  const dismissed = await command(avaSocket, 'qa:dismiss', { questionId });
  assert.equal(dismissed.featured, null);
  assert.deepEqual(dismissed.questions, []);
  assert.equal(await redis.exists(`${discussionPrefix}:qa:votes:${questionId}`), 0);
  assert.equal(
    (await command(avaSocket, 'qa:set-submissions', { open: true })).submissionsOpen,
    true,
  );
  assert.equal(await redis.get(`${discussionPrefix}:broadcast`), null);
  assert.equal(await redis.get(`${discussionPrefix}:rev`), stageRevision);
  const discussionEnded = once(samSocket, 'room:ended');
  assert.equal((await command(avaSocket, 'room:leave')).ok, true);
  assert.deepEqual(await discussionEnded, { roomId: discussion.id });
  assert.equal(
    await redis.exists(
      ...chatKeys(discussionPrefix),
      ...qaKeys(discussionPrefix),
      ...liveKeys(discussionPrefix),
    ),
    0,
  );
  assert.equal((await command(samSocket, 'chat:history')).error, 'not_joined');
  assert.equal((await command(samSocket, 'qa:state')).error, 'not_joined');

  // Real password service and two real transports; only the user repository is controlled.
  const { hashPassword } = require(`${dist}sessions/password.js`);
  const account = {
    id: randomUUID(),
    displayName: 'Registered host',
    isGuest: false,
    sessionVersion: 0,
    passwordHash: await hashPassword('original-password'),
  };
  users.set(account.id, account);
  const oldToken = await jwt.signAsync({ sub: account.id, sv: 0, guest: false });
  const openToken = async (token) => {
    const socket = client(token);
    const connected = once(socket, 'connect');
    socket.connect();
    await connected;
    return socket;
  };
  const oldA = await openToken(oldToken),
    oldB = await openToken(oldToken);
  const authRoom = room('MEETING');
  authRoom.hostId = account.id;
  const authJoin = await join(oldA, authRoom);
  assert.equal(authJoin.ok, true);
  const disconnectedA = once(oldA, 'disconnect'),
    disconnectedB = once(oldB, 'disconnect');
  const refreshedSession = await sessions.changePassword(
    account,
    'original-password',
    'replacement-password',
  );
  await Promise.all([disconnectedA, disconnectedB]);
  assert.equal(oldA.connected, false);
  assert.equal(oldB.connected, false);
  await assert.rejects(sessions.verifyToken(oldToken)); // Same verifier as the HTTP guard.
  const stale = client(oldToken),
    staleDenied = once(stale, 'connect_error');
  stale.connect();
  await staleDenied;
  const fresh = await openToken(refreshedSession.token);
  await eventually(async () => {
    const state = await redis.hget(
      `${roomPrefix(authRoom.id, namespace)}:participants`,
      authJoin.participantId,
    );
    return state && JSON.parse(state).presence === 'suspended';
  });
  const recovered = await command(fresh, 'room:resume', {
    roomId: authRoom.id,
    participantId: authJoin.participantId,
    resumeCredential: authJoin.resumeCredential,
  });
  assert.equal(recovered.ok, true);
  assert.equal(await redis.scard(`${roomPrefix(authRoom.id, namespace)}:stage`), 1);
  assert.equal((await command(fresh, 'media:state', { isAudioMuted: true })).ok, true);
  // A second password change while suspended must not make old credentials resumable.
  fresh.disconnect();
  await sessions.changePassword(
    await sessions.verifyToken(refreshedSession.token),
    'replacement-password',
    'third-password',
  );
  await assert.rejects(sessions.verifyToken(refreshedSession.token));
  await live.expire(authRoom.id, Date.now() + 21_000);
  await eventually(async () => authRoom.status === 'ENDED');
  console.log(
    'Live smoke passed: JWT/origin rejection, normalized attendee flags and no-op revisions, rejected off-stage activation/relay, ordinary stage media/ICE, suspend/resume/expiry, reserved join rejection, host grace, shutdown retry, event budgets, ordered room chat/history/dedup/pause, Q&A submit/one-vote/private acknowledgements/host moderation, and cleanup.',
  );
} finally {
  gateway?.onModuleDestroy();
  live?.onModuleDestroy();
  await chat?.onModuleDestroy();
  await qa?.onModuleDestroy();
  for (const socket of clients) socket.disconnect();
  await new Promise((resolve) => server.close(resolve));
  if (http.listening) await new Promise((resolve) => http.close(resolve));
  try {
    if (redis.status === 'ready')
      for (const id of roomIds) {
        await new QaRepository(redis).delete(roomPrefix(id, namespace));
        await redis.del(
          ...liveKeys(roomPrefix(id, namespace)),
          ...chatKeys(roomPrefix(id, namespace)),
        );
      }
  } finally {
    redis.disconnect();
  }
}
