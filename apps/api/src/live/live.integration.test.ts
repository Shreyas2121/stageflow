import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Redis } from 'ioredis';
import { applyStageCommand, type LiveState, type StageCommand } from '@stageflow/shared';
import { LiveRepository, type LiveRoom } from './live.repository';
import { LiveService, type LiveTransport } from './live.service';
import { LiveConnection } from './live.connection';
import { liveKeys, roomPrefix } from './live.keys';
import type { RoomsService } from '../rooms/rooms.service';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { SerializedOperations } from './serialized-operations';

function empty(mode: LiveState['mode'] = 'MEETING'): LiveState {
  return {
    roomId: 'room',
    hostId: 'host',
    mode,
    status: 'LIVE',
    participants: [],
    stageParticipantIds: [],
    hands: [],
    resumeDigests: {},
    deadlines: {},
  };
}

function join(
  participantId: string,
  userId = participantId,
): Extract<StageCommand, { type: 'join' }> {
  return {
    type: 'join',
    participantId,
    socketId: `socket-${participantId}`,
    userId,
    displayName: `Guest ${participantId}`,
    isAudioMuted: false,
    isVideoOff: false,
    isSyntheticBot: false,
    joinedAt: 1000,
  };
}
const hand = (participantId: string, raisedAt = 2000, raised = true): StageCommand => ({
  type: 'setHand',
  participantId,
  raisedAt,
  raised,
});
const promote = (targetParticipantId: string): StageCommand => ({
  type: 'promote',
  actorParticipantId: 'host',
  targetParticipantId,
});
const demote = (targetParticipantId: string): StageCommand => ({
  type: 'demote',
  actorParticipantId: 'host',
  targetParticipantId,
});
const lock = (kind: 'audio' | 'video', locked: boolean): StageCommand => ({
  type: 'setHostLock',
  actorParticipantId: 'host',
  targetParticipantId: 'a',
  kind,
  locked,
});
const patch = (
  values: Extract<StageCommand, { type: 'patchMedia' }>['patch'],
  participantId = 'a',
): StageCommand => ({
  type: 'patchMedia',
  participantId,
  patch: values,
});
const webinarJoins = [join('host'), join('c'), join('b'), join('a'), join('d')];
const recoverJoin = (id: string) => ({ ...join(id), resumeDigest: `digest-${id}` });
const suspend = (participantId: string, now = 2000): StageCommand => ({
  type: 'suspend',
  participantId,
  now,
});
const resume = (
  participantId: string,
  now = 2001,
  expectedGeneration = 1,
): Extract<StageCommand, { type: 'resume' }> => ({
  type: 'resume',
  participantId,
  now,
  expectedGeneration,
  userId: participantId,
  socketId: `resumed-${participantId}`,
  resumeDigest: `digest-${participantId}`,
});

const scenarios: { name: string; initial: LiveState; commands: StageCommand[] }[] = [
  {
    name: 'suspend and resume preserve a locked membership, hand and join order',
    initial: empty('WEBINAR'),
    commands: [
      recoverJoin('host'),
      recoverJoin('a'),
      hand('a'),
      lock('audio', true),
      suspend('a'),
      suspend('a'),
      resume('a'),
      { ...resume('a'), expectedGeneration: 2 },
      resume('a'),
      suspend('a', 3000),
      { ...resume('a', 3001, 2), socketId: 'third-a' },
    ],
  },
  {
    name: 'suspended reservations enforce the cap and demotion survives resume',
    initial: empty('WEBINAR'),
    commands: [
      recoverJoin('host'),
      recoverJoin('a'),
      recoverJoin('b'),
      recoverJoin('c'),
      recoverJoin('d'),
      promote('a'),
      promote('b'),
      promote('c'),
      suspend('a'),
      promote('d'),
      demote('a'),
      promote('a'),
      promote('d'),
      resume('a'),
    ],
  },
  {
    name: 'host suspension removes bots and host expiry ends all presence',
    initial: empty(),
    commands: [
      recoverJoin('host'),
      { ...join('bot'), isSyntheticBot: true },
      recoverJoin('human'),
      suspend('host'),
      { type: 'expire', now: 21999 },
      { type: 'expire', now: 22000 },
    ],
  },
  {
    name: 'synthetic disconnect leaves immediately',
    initial: empty(),
    commands: [recoverJoin('host'), { ...join('bot'), isSyntheticBot: true }, suspend('bot')],
  },
  {
    name: 'join expires an overdue guest atomically before admitting the same user',
    initial: empty(),
    commands: [
      recoverJoin('host'),
      recoverJoin('a'),
      suspend('a'),
      { ...join('new-a', 'a'), now: 22000 },
    ],
  },
  {
    name: 'join after overdue host commits expiry and rejects insertion',
    initial: empty(),
    commands: [recoverJoin('host'), suspend('host'), { ...join('new-user'), now: 22000 }],
  },
  {
    name: 'resume at the deadline expires the row instead of rebinding it',
    initial: empty(),
    commands: [recoverJoin('host'), recoverJoin('a'), suspend('a'), resume('a', 22000)],
  },
  {
    name: 'resume validates owner, digest and live generation without replacing a connection',
    initial: empty(),
    commands: [
      recoverJoin('host'),
      recoverJoin('a'),
      resume('a'),
      suspend('a'),
      { ...resume('a'), userId: 'wrong' },
      { ...resume('a'), resumeDigest: 'wrong' },
      resume('missing'),
      resume('a'),
      { type: 'expire', now: 99999 },
      {
        ...patch({ isAudioMuted: false }),
        transport: { participantId: 'a', socketId: 'socket-a', generation: 1 },
      },
      {
        ...demote('a'),
        transport: { participantId: 'host', socketId: 'socket-host', generation: 99 },
      },
      {
        type: 'leave',
        participantId: 'a',
        transport: { participantId: 'a', socketId: 'socket-a', generation: 1 },
      },
    ],
  },
  {
    name: 'host-first meeting roles and fifth join rejection',
    initial: empty(),
    commands: [join('a'), join('host'), join('z'), join('b'), join('a'), join('fifth')],
  },
  {
    name: 'duplicate user and socket rejection',
    initial: empty(),
    commands: [join('host'), join('new-socket', 'host'), join('host', 'different-user')],
  },
  {
    name: 'webinar guest before and after host; synthetic bot grants no role',
    initial: empty('WEBINAR'),
    commands: [{ ...join('z'), isSyntheticBot: true }, join('host'), join('a')],
  },
  {
    name: 'ended room rejection',
    initial: { ...empty(), status: 'ENDED' },
    commands: [join('host')],
  },
  {
    name: 'unknown leave and speaker leave',
    initial: empty(),
    commands: [
      { type: 'leave', participantId: 'missing' },
      join('host'),
      join('a'),
      { type: 'leave', participantId: 'a' },
    ],
  },
  {
    name: 'attendee leave removes hand and host leave empties the room',
    initial: empty('WEBINAR'),
    commands: [
      ...webinarJoins,
      hand('a'),
      { type: 'leave', participantId: 'a' },
      hand('b'),
      { type: 'leave', participantId: 'host' },
      join('new-user'),
    ],
  },
  {
    name: 'canonical hand ordering, repeated raise, lower and raise again',
    initial: empty('WEBINAR'),
    commands: [
      ...webinarJoins,
      hand('c', 3000),
      hand('b'),
      hand('a'),
      hand('a', 9000),
      hand('a', 4000, false),
      hand('a', 4000),
      hand('host'),
      hand('missing'),
    ],
  },
  {
    name: 'promote fourth slot, clear hand, reject full stage and non-attendee',
    initial: empty('WEBINAR'),
    commands: [
      ...webinarJoins,
      promote('a'),
      hand('a'),
      promote('b'),
      hand('c'),
      promote('c'),
      promote('d'),
      promote('a'),
    ],
  },
  {
    name: 'demote speaker, reject host and non-speaker, then raise hand',
    initial: empty('WEBINAR'),
    commands: [...webinarJoins, demote('host'), demote('a'), promote('a'), demote('a'), hand('a')],
  },
  {
    name: 'missing participants and partial/no-op media patches',
    initial: empty('WEBINAR'),
    commands: [
      ...webinarJoins,
      promote('a'),
      patch({ isAudioMuted: false, isVideoOff: false }),
      patch({}, 'missing'),
      patch({}),
      patch({ isAudioMuted: true }),
      patch({ isAudioMuted: true }),
      patch({ isScreenSharing: true, isVideoOff: true }),
      patch({ isScreenSharing: false }),
    ],
  },
];
for (const kind of ['audio', 'video'] as const) {
  const flag = kind === 'audio' ? 'isAudioMuted' : 'isVideoOff';
  scenarios.push({
    name: `${kind} lock, rejected device activation, unlock stays off`,
    initial: empty('WEBINAR'),
    commands: [
      ...webinarJoins,
      promote('a'),
      lock(kind, true),
      patch({ [flag]: false, isScreenSharing: true }),
      lock(kind, true),
      lock(kind, false),
      patch({ [flag]: false, isScreenSharing: true }),
    ],
  });
}
for (const type of ['promote', 'demote', 'setHostLock'] as const) {
  scenarios.push({
    name: `${type} requires host actor and existing target`,
    initial: empty('WEBINAR'),
    commands: [
      ...webinarJoins,
      ...[
        { actorParticipantId: 'a', targetParticipantId: 'b' },
        { actorParticipantId: 'missing', targetParticipantId: 'b' },
        { actorParticipantId: 'host', targetParticipantId: 'missing' },
      ].map((ids) => ({ type, ...ids, kind: 'audio', locked: true }) as StageCommand),
    ],
  });
}

describe('Redis Lua stage transitions', () => {
  let redis: Redis;
  let repository: LiveRepository;
  const prefixes = new Set<string>();
  const keys = (prefix: string) =>
    ['rev', 'participants', 'stage', 'hands', 'transports'].map((suffix) => `${prefix}:${suffix}`);
  async function remove(value: string) {
    await redis.del(...liveKeys(value));
  }
  function prefix() {
    const value = `sf:itest:${randomUUID()}`;
    prefixes.add(value);
    return value;
  }

  beforeAll(async () => {
    if (!process.env.REDIS_URL?.trim())
      throw new Error('REDIS_URL is required for Redis integration tests.');
    redis = new Redis(process.env.REDIS_URL, {
      lazyConnect: true,
      connectTimeout: 3000,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
    });
    redis.on('error', () => {
      /* connect/ping rejection fails the suite below */
    });
    await redis.connect();
    expect(await redis.ping()).toBe('PONG');
    repository = new LiveRepository(redis);
  });

  afterAll(async () => {
    if (!redis) return;
    try {
      if (redis.status === 'ready') {
        for (const value of prefixes) await remove(value);
      }
    } finally {
      redis.disconnect();
    }
  });

  async function stored(value: string) {
    const [revKey, participantsKey, stageKey, handsKey] = keys(value) as [
      string,
      string,
      string,
      string,
    ];
    return {
      revision: Number(await redis.get(revKey)),
      participants: Object.values(await redis.hgetall(participantsKey)).map(
        (raw) => JSON.parse(raw) as unknown,
      ),
      stage: (await redis.smembers(stageKey)).sort(),
      hands: await redis.zrange(handsKey, 0, '-1', 'WITHSCORES'),
      transports: await redis.hgetall(`${value}:transports`),
      resumeDigests: await redis.hgetall(`${value}:resume`),
      deadlines: Object.fromEntries(
        (await redis.zrange(`${value}:deadlines`, 0, '-1', 'WITHSCORES')).reduce(
          (items, value, index, values) =>
            index % 2 === 0 ? [...items, [value, Number(values[index + 1])]] : items,
          [] as [string, number][],
        ),
      ),
    };
  }

  it('admits one broadcast atomically, preserves the active id, and clears only that key', async () => {
    const value = prefix();
    const room = empty('WEBINAR');
    await repository.apply(value, room, join('host'));
    const before = await stored(value);
    const results = await Promise.all([
      repository.tryBeginBroadcast(value, 'broadcast-one'),
      repository.tryBeginBroadcast(value, 'broadcast-two'),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const activeId = results[0] ? 'broadcast-one' : 'broadcast-two';
    expect(await redis.get(`${value}:broadcast`)).toBe(activeId);
    await repository.clearBroadcast(value, 'another-broadcast');
    expect(await repository.readBroadcast(value)).toBe(activeId);
    expect(await repository.tryBeginBroadcast(value, 'broadcast-three')).toBe(false);
    expect(await redis.get(`${value}:broadcast`)).toBe(activeId);
    await repository.clearBroadcast(value);
    expect(await redis.get(`${value}:broadcast`)).toBeNull();
    expect(await stored(value)).toEqual(before);
    await repository.clearBroadcast(value);
    expect(await repository.tryBeginBroadcast(value, 'broadcast-four')).toBe(true);
    const refreshed = await repository.refreshSnapshot(value, room);
    expect(refreshed.revision).toBe(before.revision + 1);
    expect(refreshed.state.participants).toEqual(before.participants);
    expect(refreshed.state.stageParticipantIds).toEqual(before.stage);
    await repository.deleteRoom(value);
    expect(await redis.exists(`${value}:broadcast`)).toBe(0);
  });

  it('resolves transports independently of membership ids and removes them on leave', async () => {
    const value = prefix();
    const room = empty('WEBINAR');
    const command = { ...join('member'), socketId: 'transport' };
    const result = await repository.apply(value, room, command);
    expect(result.ok).toBe(true);
    expect(await redis.hget(`${value}:transports`, 'transport')).toBe('member');
    expect(await repository.readParticipant(value, 'transport')).toBeNull();
    expect(await repository.readSocket(value, 'member')).toBe('transport');
    await redis.hdel(`${value}:transports`, 'transport');
    expect(await repository.readSocket(value, 'member')).toBeNull();
    await redis.hset(`${value}:transports`, 'transport', 'member');
    await repository.apply(value, room, { type: 'leave', participantId: 'member' });
    expect(await redis.hlen(`${value}:transports`)).toBe(0);
    expect(await repository.readParticipant(value, 'member')).toBeNull();
  });

  it('binds only one of two simultaneous resumes and rejects every stale mutation', async () => {
    const value = prefix();
    const room = empty();
    for (const command of [recoverJoin('host'), recoverJoin('a'), suspend('a')])
      await repository.apply(value, room, command);
    const results = await Promise.all(
      ['one', 'two'].map((socketId) => repository.apply(value, room, { ...resume('a'), socketId })),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toMatchObject({ error: 'resume_lost' });
    const current = await repository.readParticipant(value, 'a');
    expect(current).toMatchObject({ presence: 'connected', connectionGeneration: 2 });
    expect(await redis.hget(`${value}:transports`, current!.socketId!)).toBe('a');
    expect(await redis.zscore(`${value}:deadlines`, 'a')).toBeNull();
    const before = await stored(value);
    const transport = { participantId: 'a', socketId: 'socket-a', generation: 1 };
    for (const command of [
      patch({ isAudioMuted: false }),
      { type: 'leave', participantId: 'a' } as const,
      {
        type: 'setHostLock',
        actorParticipantId: 'a',
        targetParticipantId: 'host',
        kind: 'audio',
        locked: true,
      } as const,
    ]) {
      expect(await repository.apply(value, room, { ...command, transport })).toMatchObject({
        error: 'stale_transport',
      });
      expect(await stored(value)).toEqual(before);
    }
  });

  it('suspends a committed join when its socket is already gone, and a stale binding cannot evict the next generation', async () => {
    const roomId = randomUUID();
    const namespace = 'itest';
    const value = roomPrefix(roomId, namespace);
    prefixes.add(value);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const liveRoom: LiveRoom = {
      roomId,
      hostId: 'host-user',
      mode: 'MEETING',
      status: 'LIVE',
    };
    const live = {
      apply: async (key: string, room: LiveRoom, command: StageCommand) => {
        if (command.type === 'join') {
          markEntered();
          await gate;
        }
        return repository.apply(key, room, command);
      },
      readStage: (key: string) => repository.readStage(key),
      readConnectedStage: (key: string) => repository.readConnectedStage(key),
      readSocket: (key: string, participantId: string) => repository.readSocket(key, participantId),
      readParticipant: (key: string, participantId: string) =>
        repository.readParticipant(key, participantId),
      deleteRoom: (key: string) => repository.deleteRoom(key),
    };
    const rooms: Pick<RoomsService, 'getById' | 'end'> = {
      getById: async () =>
        ({ ...liveRoom, id: roomId }) as unknown as Awaited<ReturnType<RoomsService['getById']>>,
      end: async () => undefined,
    };
    const service = new LiveService(rooms, live, new SerializedOperations(), undefined, namespace);
    const sockets: LiveTransport = {
      join: async () => undefined,
      leave: async () => undefined,
      publish: () => undefined,
      forceMute: () => undefined,
      peer: () => undefined,
      end: () => undefined,
    };
    const client = {
      id: 'socket-host',
      user: { id: 'host-user', displayName: 'Host' },
      connected: true,
      room: undefined as LiveRoom | undefined,
      participantId: undefined as string | undefined,
      generation: undefined as number | undefined,
    };
    const joining = service.join(
      client,
      { roomId, isAudioMuted: true, isVideoOff: true, isSyntheticBot: false },
      sockets,
      'host-member',
      'digest-host',
    );
    await entered;
    client.connected = false;
    await service.disconnect(client, sockets);
    release();
    await expect(joining).resolves.toMatchObject({ ok: false, error: 'not_joined' });
    await expect(repository.readParticipant(value, 'host-member')).resolves.toMatchObject({
      presence: 'suspended',
      socketId: null,
      connectionGeneration: 1,
      role: 'HOST',
    });
    expect(await redis.zscore(`${value}:deadlines`, 'host-member')).not.toBeNull();
    expect(await redis.hget(`${value}:transports`, 'socket-host')).toBeNull();
    const resumed = await repository.apply(value, liveRoom, {
      type: 'resume',
      participantId: 'host-member',
      userId: 'host-user',
      socketId: 'socket-new',
      resumeDigest: 'digest-host',
      expectedGeneration: 1,
      now: Date.now(),
    });
    expect(resumed.ok).toBe(true);
    const before = await stored(value);
    client.room = liveRoom;
    client.participantId = 'host-member';
    client.generation = 1;
    await expect(service.disconnect(client, sockets)).resolves.toMatchObject({
      error: 'stale_transport',
    });
    expect(await stored(value)).toEqual(before);
    await expect(repository.readParticipant(value, 'host-member')).resolves.toMatchObject({
      presence: 'connected',
      socketId: 'socket-new',
      connectionGeneration: 2,
    });
    service.onModuleDestroy();
  });

  it.each([true, false])(
    'keeps one membership when resume and expiry race (resume first %s)',
    async (resumeFirst) => {
      const value = prefix();
      const room = empty();
      for (const command of [recoverJoin('host'), recoverJoin('a'), suspend('a')])
        await repository.apply(value, room, command);
      const commands: StageCommand[] = [resume('a', 21999), { type: 'expire', now: 22000 }];
      await Promise.all(
        (resumeFirst ? commands : commands.reverse()).map((command) =>
          repository.apply(value, room, command),
        ),
      );
      const state = await stored(value);
      expect(state.participants.length).toBeLessThanOrEqual(2);
      expect(state.stage.length).toBeLessThanOrEqual(4);
      const member = await repository.readParticipant(value, 'a');
      if (member) {
        expect(member).toMatchObject({ presence: 'connected', connectionGeneration: 2 });
        expect(state.transports[member.socketId!]).toBe('a');
      } else {
        expect(state.stage).toEqual(['host']);
        expect(state.resumeDigests.a).toBeUndefined();
      }
    },
  );

  it('keeps suspended stage ids reserved and can demote a null-socket membership', async () => {
    const value = prefix();
    const room = empty('WEBINAR');
    for (const command of [...webinarJoins, promote('a'), promote('b'), promote('c')])
      await repository.apply(value, room, command);
    const current = await repository.refreshSnapshot(value, room);
    const suspended = await repository.apply(value, room, {
      type: 'suspend',
      participantId: 'a',
      now: 2000,
    });
    if (!suspended.ok) throw new Error(suspended.error);
    expect((await repository.readParticipant(value, 'a'))?.socketId).toBeNull();
    expect(await repository.readConnectedStage(value)).toEqual(
      expect.arrayContaining(['host', 'b', 'c']),
    );
    expect(await repository.readConnectedStage(value)).not.toContain('a');
    expect(await repository.apply(value, room, promote('d'))).toMatchObject({
      error: 'stage_full',
    });
    const expected = applyStageCommand(suspended.state, demote('a'));
    expect(await repository.apply(value, room, demote('a'))).toEqual({
      ...expected,
      revision: current.revision + 2,
    });
    expect(await repository.apply(value, room, promote('a'))).toMatchObject({
      error: 'not_connected',
    });
    expect(await repository.apply(value, room, promote('d'))).toMatchObject({ ok: true });
  });

  it.each(scenarios)(
    '$name matches the pure function at every step',
    async ({ initial, commands }) => {
      const value = prefix();
      let state = initial;
      let revision = 0;
      try {
        for (const command of commands) {
          const expected = applyStageCommand(state, command);
          const before = await stored(value);
          const actual = await repository.apply(value, state, command);
          if (!expected.ok) {
            if (expected.expiry?.changed) {
              revision++;
              state = expected.expiry.state;
            }
            expect(actual).toEqual({ ...expected, revision });
            if (!expected.expiry) expect(await stored(value)).toEqual(before);
          } else {
            if (expected.changed) revision += 1;
            expect(actual).toEqual({ ...expected, revision });
            state = expected.state;
            const persisted = await stored(value);
            expect(persisted.revision).toBe(revision);
            expect(persisted.resumeDigests).toEqual(state.resumeDigests);
            expect(persisted.deadlines).toEqual(state.deadlines);
            expect(persisted.participants).toEqual(expect.arrayContaining(state.participants));
            expect(persisted.participants).toHaveLength(state.participants.length);
            expect(persisted.stage).toEqual(state.stageParticipantIds);
            expect(persisted.transports).toEqual(
              Object.fromEntries(
                state.participants
                  .filter((p) => p.socketId !== null)
                  .map((p) => [p.socketId, p.participantId]),
              ),
            );
            expect(persisted.hands).toEqual(
              state.hands.flatMap((h) => [h.participantId, String(h.raisedAt)]),
            );
            if (!expected.changed) expect(persisted).toEqual(before);
            for (const key of keys(value)) {
              const ttl = await redis.ttl(key);
              expect(ttl === -2 || (ttl > 86390 && ttl <= 86400)).toBe(true);
            }
          }
        }
      } finally {
        await remove(value);
      }
    },
  );

  it.each(
    [false, true].flatMap((isAudioMuted) =>
      [false, true].flatMap((isVideoOff) =>
        [false, true].map((isSyntheticBot) => ({ isAudioMuted, isVideoOff, isSyntheticBot })),
      ),
    ),
  )('normalizes attendee join flags %j before persisting a snapshot', async (flags) => {
    const value = prefix();
    const result = await repository.apply(value, empty('WEBINAR'), { ...join('guest'), ...flags });
    expect(result).toMatchObject({
      ok: true,
      changed: true,
      revision: 1,
      state: {
        stageParticipantIds: [],
        participants: [
          {
            role: 'ATTENDEE',
            isAudioMuted: true,
            isVideoOff: true,
            isScreenSharing: false,
            isSyntheticBot: flags.isSyntheticBot,
          },
        ],
      },
    });
    const persisted = await stored(value);
    expect(persisted.stage).toEqual([]);
    expect(persisted.participants).toMatchObject([
      { role: 'ATTENDEE', isAudioMuted: true, isVideoOff: true, isScreenSharing: false },
    ]);
  });

  it('rejects off-stage activation without any write or TTL refresh and preserves canonical no-ops', async () => {
    const value = prefix(),
      room = empty('WEBINAR');
    for (const command of [join('host'), { ...join('a'), isSyntheticBot: true }, hand('a')])
      await repository.apply(value, room, command);
    const before = await stored(value);
    for (const key of keys(value)) await redis.expire(key, 120);
    for (const flags of [
      { isAudioMuted: false },
      { isVideoOff: false },
      { isScreenSharing: true },
      { isAudioMuted: true, isVideoOff: false, isScreenSharing: false },
    ]) {
      expect(await repository.apply(value, room, patch(flags))).toEqual({
        ok: false,
        error: 'not_on_stage',
        revision: before.revision,
      });
      expect(await stored(value)).toEqual(before);
    }
    for (const flags of [
      {},
      { isAudioMuted: true },
      { isVideoOff: true },
      { isScreenSharing: false },
      { isAudioMuted: true, isVideoOff: true, isScreenSharing: false },
    ]) {
      expect(await repository.apply(value, room, patch(flags))).toMatchObject({
        ok: true,
        changed: false,
        revision: before.revision,
      });
      expect(await stored(value)).toEqual(before);
    }
    for (const key of keys(value)) expect(await redis.ttl(key)).toBeLessThanOrEqual(120);
  });

  it('repairs legacy off-stage flags exactly once and matches the oracle without changing unrelated state', async () => {
    const value = prefix(),
      room = empty('WEBINAR');
    await repository.apply(value, room, join('host'));
    await repository.apply(value, room, { ...join('a'), isSyntheticBot: true });
    const result = await repository.apply(value, room, hand('a'));
    if (!result.ok) throw new Error(result.error);
    const legacy: LiveState = {
      ...result.state,
      participants: result.state.participants.map((p) =>
        p.participantId === 'a'
          ? {
              ...p,
              isAudioMuted: false,
              isVideoOff: false,
              isScreenSharing: true,
              hostAudioLocked: true,
            }
          : p,
      ),
    };
    const participant = legacy.participants.find((p) => p.participantId === 'a')!;
    await redis.hset(`${value}:participants`, 'a', JSON.stringify(participant));
    const before = await stored(value);
    expect(await repository.apply(value, room, patch({ isAudioMuted: false }))).toEqual({
      ok: false,
      error: 'not_on_stage',
      revision: 3,
    });
    expect(await stored(value)).toEqual(before);
    const expected = applyStageCommand(legacy, patch({}));
    const repaired = await repository.apply(value, room, patch({}));
    expect(repaired).toEqual({ ...expected, revision: 4 });
    expect((await stored(value)).stage).toEqual(before.stage);
    expect((await stored(value)).hands).toEqual(before.hands);
    expect(await repository.apply(value, room, patch({}))).toMatchObject({
      ok: true,
      changed: false,
      revision: 4,
    });
    await repository.apply(value, room, promote('a'));
    expect(await repository.apply(value, room, patch({ isAudioMuted: false }))).toMatchObject({
      ok: false,
      error: 'audio_locked',
    });
  });

  it('normalizes all media flags on internal demotion after ordinary stage activation/sharing', async () => {
    const value = prefix(),
      room = empty('WEBINAR');
    let state = room;
    let revision = 0;
    for (const command of [
      join('host'),
      join('a'),
      promote('a'),
      patch({ isAudioMuted: false, isVideoOff: false, isScreenSharing: true }),
      demote('a'),
      patch({ isScreenSharing: true }),
      patch({ isAudioMuted: true, isVideoOff: true, isScreenSharing: false }),
    ]) {
      const expected = applyStageCommand(state, command);
      if (expected.ok && expected.changed) revision++;
      const actual = await repository.apply(value, room, command);
      expect(actual).toEqual({ ...expected, revision });
      if (expected.ok) state = expected.state;
    }
    expect(revision).toBe(5);
    expect(state.participants.find((p) => p.participantId === 'a')).toMatchObject({
      role: 'ATTENDEE',
      isAudioMuted: true,
      isVideoOff: true,
      isScreenSharing: false,
    });
    expect(state.stageParticipantIds).toEqual(['host']);
  });

  it('refreshes all live key TTLs only on changes', async () => {
    const value = prefix();
    const room = empty('WEBINAR');
    await repository.apply(value, room, join('host'));
    await repository.apply(value, room, join('a'));
    await repository.apply(value, room, hand('a'));
    for (const key of keys(value)) await redis.expire(key, 120);
    await repository.apply(value, room, join('new-socket', 'a'));
    await repository.apply(value, room, { type: 'leave', participantId: 'missing' });
    await repository.apply(
      value,
      room,
      patch({ isAudioMuted: true, isVideoOff: true, isScreenSharing: false }),
    );
    await repository.apply(value, room, patch({ isAudioMuted: false }));
    for (const key of keys(value)) expect(await redis.ttl(key)).toBeLessThanOrEqual(120);
    await repository.apply(value, room, patch({ isVideoOff: true }, 'host'));
    for (const key of keys(value)) expect(await redis.ttl(key)).toBeGreaterThan(86390);
    expect(await redis.exists(`${value}:broadcast`)).toBe(0);
  });

  it('resets only the configured namespace and leaves another namespace intact', async () => {
    const namespace = `sf_itest_${randomUUID()}`;
    const own = roomPrefix('room', namespace);
    const other = roomPrefix('room', `${namespace}_other`);
    prefixes.add(own);
    prefixes.add(other);
    await repository.apply(own, empty(), join('host'));
    await repository.apply(other, empty(), join('host'));
    await repository.tryBeginBroadcast(own, 'own-broadcast');
    await repository.tryBeginBroadcast(other, 'other-broadcast');
    const connection = new LiveConnection(redis.duplicate({ lazyConnect: true }), namespace);
    try {
      await connection.open();
      expect(connection.isReady()).toBe(true);
      expect(await redis.exists(...keys(own))).toBe(0);
      expect(await redis.get(`${own}:broadcast`)).toBeNull();
      expect(await redis.get(`${other}:broadcast`)).toBe('other-broadcast');
      expect(await redis.hget(`${other}:participants`, 'host')).not.toBeNull();
      expect(await redis.get(`${other}:rev`)).toBe('1');
      await repository.apply(own, empty(), join('host'));
      await repository.tryBeginBroadcast(own, 'new-broadcast');
      const contender = new LiveConnection(redis.duplicate({ lazyConnect: true }), namespace);
      await expect(contender.open()).rejects.toThrow('already has an API owner');
      expect(await redis.hget(`${own}:participants`, 'host')).not.toBeNull();
      expect(await redis.get(`${own}:broadcast`)).toBe('new-broadcast');
      expect(await redis.get(`${namespace}:owner`)).not.toBeNull();
    } finally {
      await connection.onApplicationShutdown();
    }
    expect(await redis.get(`${namespace}:owner`)).toBeNull();
    const replacement = new LiveConnection(redis.duplicate({ lazyConnect: true }), namespace);
    try {
      await replacement.open();
      expect(await redis.exists(...keys(own))).toBe(0);
    } finally {
      await replacement.onApplicationShutdown();
    }
  });

  it('keeps namespace ownership until Nest shutdown has drained active live work', async () => {
    const namespace = `sf_itest_${randomUUID()}`;
    const connection = new LiveConnection(redis.duplicate({ lazyConnect: true }), namespace);
    const operations = new SerializedOperations();
    class OwnershipTestModule {}
    Module({
      providers: [
        { provide: LiveConnection, useValue: connection },
        { provide: SerializedOperations, useValue: operations },
      ],
    })(OwnershipTestModule);
    const app = await NestFactory.createApplicationContext(OwnershipTestModule, { logger: false });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const work = operations.run('room:pending', () => gate);
    const shutdown = app.close();
    try {
      await vi.waitFor(() => expect(connection.isReady()).toBe(false));
      expect(await redis.get(`${namespace}:owner`)).not.toBeNull();
      const contender = new LiveConnection(redis.duplicate({ lazyConnect: true }), namespace);
      await expect(contender.open()).rejects.toThrow('already has an API owner');
    } finally {
      release();
      await Promise.all([work, shutdown]);
    }
    expect(await redis.get(`${namespace}:owner`)).toBeNull();
  });

  it('writes only the affected participant, stage membership and hand entry', async () => {
    const value = prefix();
    const room = empty('WEBINAR');
    for (const command of [...webinarJoins, hand('b')])
      await repository.apply(value, room, command);
    const unrelated = await redis.hget(`${value}:participants`, 'b');
    const monitor = await redis.monitor();
    const observed: string[][] = [];
    monitor.on('monitor', (_time: string, args: string[]) => observed.push(args));
    async function writes(command: StageCommand) {
      observed.length = 0;
      await repository.apply(value, room, command);
      const marker = randomUUID();
      await redis.echo(marker);
      await vi.waitFor(() =>
        expect(observed.some((args) => args[0] === 'echo' && args[1] === marker)).toBe(true),
      );
      return observed.filter((args) =>
        /^(hset|hdel|sadd|srem|zadd|zrem|del)$/i.test(args[0] ?? ''),
      );
    }
    try {
      const mute = await writes(patch({ isAudioMuted: true }, 'host'));
      expect(mute.map((args) => args.slice(0, 3))).toEqual([
        ['HSET', `${value}:participants`, 'host'],
      ]);
      expect(await redis.hget(`${value}:participants`, 'b')).toBe(unrelated);
      expect(await redis.zscore(`${value}:hands`, 'b')).toBe('2000');
      const raise = await writes(hand('a'));
      expect(raise.map((args) => [args[0], args[1], args.at(-1) === 'a'])).toEqual([
        ['HSET', `${value}:participants`, false],
        ['ZADD', `${value}:hands`, true],
      ]);
      const promotion = await writes(promote('a'));
      expect(promotion.map((args) => args.slice(0, 3))).toEqual([
        ['HSET', `${value}:participants`, 'a'],
        ['SADD', `${value}:stage`, 'a'],
        ['ZREM', `${value}:hands`, 'a'],
      ]);
      const demotion = await writes(demote('a'));
      expect(demotion.map((args) => args.slice(0, 3))).toEqual([
        ['HSET', `${value}:participants`, 'a'],
        ['SREM', `${value}:stage`, 'a'],
      ]);
      await writes(hand('a'));
      const leave = await writes({ type: 'leave', participantId: 'a' });
      expect(leave.map((args) => args.slice(0, 3))).toEqual([
        ['HDEL', `${value}:transports`, 'socket-a'],
        ['HDEL', `${value}:participants`, 'a'],
        ['ZREM', `${value}:hands`, 'a'],
      ]);
      expect(await redis.hget(`${value}:participants`, 'b')).toBe(unrelated);
      expect(await writes(patch({ isAudioMuted: false }, 'b'))).toEqual([]);
      expect(await writes(patch({}, 'missing'))).toEqual([]);
    } finally {
      monitor.disconnect();
    }
  });

  it('admits only one concurrent join into the last stage slot', async () => {
    const value = prefix();
    const room = empty();
    for (const id of ['host', 'a', 'b']) await repository.apply(value, room, join(id));
    const results = await Promise.all(
      ['c', 'd'].map((id) => repository.apply(value, room, join(id))),
    );
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.find((result) => !result.ok)).toMatchObject({
      ok: false,
      error: 'stage_full',
      revision: 4,
    });
    expect((await stored(value)).stage).toHaveLength(4);
    expect((await stored(value)).revision).toBe(4);
  });

  it('admits only one concurrent promotion into the last stage slot', async () => {
    const value = prefix();
    const room = empty('WEBINAR');
    for (const command of [...webinarJoins, promote('a'), promote('b')])
      await repository.apply(value, room, command);
    const results = await Promise.all(
      ['c', 'd'].map((id) => repository.apply(value, room, promote(id))),
    );
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.find((result) => !result.ok)).toMatchObject({
      ok: false,
      error: 'stage_full',
      revision: 8,
    });
    expect((await stored(value)).stage).toHaveLength(4);
  });

  it('preserves independent concurrent media changes', async () => {
    const value = prefix();
    const room = empty();
    await repository.apply(value, room, join('host'));
    await repository.apply(value, room, join('a'));
    await Promise.all([
      repository.apply(value, room, patch({ isAudioMuted: true })),
      repository.apply(value, room, patch({ isVideoOff: true })),
    ]);
    const result = await repository.apply(value, room, patch({}));
    expect(result).toMatchObject({ ok: true, changed: false, revision: 4 });
    if (!result.ok) throw new Error(result.error);
    expect(result.state.participants.find((p) => p.participantId === 'a')).toMatchObject({
      isAudioMuted: true,
      isVideoOff: true,
    });
  });

  it('keeps host-ending intent after the host record is gone and blocks joins', async () => {
    const value = prefix();
    const room = empty();
    try {
      await repository.apply(value, room, join('host'));
      await repository.apply(value, room, join('guest'));
      const ended = await repository.apply(value, room, { type: 'leave', participantId: 'host' });
      expect(ended).toMatchObject({
        ok: true,
        changed: true,
        roomEnded: true,
        state: { status: 'ENDED', participants: [] },
      });
      expect(await redis.exists(`${value}:ending`)).toBe(1);
      const ttl = await redis.ttl(`${value}:ending`);
      expect(ttl > 86390 && ttl <= 86400).toBe(true);
      const revision = Number(await redis.get(`${value}:rev`));
      await redis.expire(`${value}:ending`, 120);
      await redis.expire(`${value}:rev`, 120);
      const retry = await repository.apply(value, room, { type: 'leave', participantId: 'guest' });
      expect(retry).toMatchObject({ ok: true, changed: false, roomEnded: true, revision });
      expect(Number(await redis.get(`${value}:rev`))).toBe(revision);
      expect(await redis.ttl(`${value}:ending`)).toBeGreaterThan(86390);
      expect(await redis.ttl(`${value}:rev`)).toBeLessThanOrEqual(120);
      expect(await repository.apply(value, room, join('late'))).toMatchObject({
        ok: false,
        error: 'room_ended',
        revision,
      });
      expect((await stored(value)).participants).toEqual([]);
      await repository.deleteRoom(value);
      for (const suffix of ['rev', 'participants', 'stage', 'hands', 'ending']) {
        expect(await redis.exists(`${value}:${suffix}`)).toBe(0);
      }
      expect(await repository.apply(value, room, join('late'))).toMatchObject({
        ok: false,
        error: 'host_not_present',
        revision: 0,
      });
      expect(await repository.apply(value, room, join('host'))).toMatchObject({
        ok: true,
        changed: true,
      });
    } finally {
      await remove(value);
    }
  });
});
