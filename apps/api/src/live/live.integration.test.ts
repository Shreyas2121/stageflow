import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Redis } from 'ioredis';
import { applyStageCommand, type LiveState, type StageCommand } from '@stageflow/shared';
import { LiveRepository } from './live.repository';
import { LiveConnection } from './live.connection';
import { roomPrefix } from './live.keys';

function empty(mode: LiveState['mode'] = 'MEETING'): LiveState {
  return {
    roomId: 'room',
    hostId: 'host',
    mode,
    status: 'LIVE',
    participants: [],
    stageSocketIds: [],
    hands: [],
  };
}

function join(socketId: string, userId = socketId): Extract<StageCommand, { type: 'join' }> {
  return {
    type: 'join',
    socketId,
    userId,
    displayName: `Guest ${socketId}`,
    isAudioMuted: false,
    isVideoOff: false,
    isSyntheticBot: false,
    joinedAt: 1000,
  };
}
const hand = (socketId: string, raisedAt = 2000, raised = true): StageCommand => ({
  type: 'setHand',
  socketId,
  raisedAt,
  raised,
});
const promote = (targetSocketId: string): StageCommand => ({
  type: 'promote',
  actorSocketId: 'host',
  targetSocketId,
});
const demote = (targetSocketId: string): StageCommand => ({
  type: 'demote',
  actorSocketId: 'host',
  targetSocketId,
});
const lock = (kind: 'audio' | 'video', locked: boolean): StageCommand => ({
  type: 'setHostLock',
  actorSocketId: 'host',
  targetSocketId: 'a',
  kind,
  locked,
});
const patch = (
  values: Extract<StageCommand, { type: 'patchMedia' }>['patch'],
  socketId = 'a',
): StageCommand => ({
  type: 'patchMedia',
  socketId,
  patch: values,
});
const webinarJoins = [join('host'), join('c'), join('b'), join('a'), join('d')];

const scenarios: { name: string; initial: LiveState; commands: StageCommand[] }[] = [
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
      { type: 'leave', socketId: 'missing' },
      join('host'),
      join('a'),
      { type: 'leave', socketId: 'a' },
    ],
  },
  {
    name: 'attendee leave removes hand and host leave empties the room',
    initial: empty('WEBINAR'),
    commands: [
      ...webinarJoins,
      hand('a'),
      { type: 'leave', socketId: 'a' },
      hand('b'),
      { type: 'leave', socketId: 'host' },
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
        { actorSocketId: 'a', targetSocketId: 'b' },
        { actorSocketId: 'missing', targetSocketId: 'b' },
        { actorSocketId: 'host', targetSocketId: 'missing' },
      ].map((ids) => ({ type, ...ids, kind: 'audio', locked: true }) as StageCommand),
    ],
  });
}

describe('Redis Lua stage transitions', () => {
  let redis: Redis;
  let repository: LiveRepository;
  const prefixes = new Set<string>();
  const keys = (prefix: string) =>
    ['rev', 'participants', 'stage', 'hands'].map((suffix) => `${prefix}:${suffix}`);
  async function remove(value: string) {
    await redis.del(...keys(value), `${value}:ending`);
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
    };
  }

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
            expect(actual).toEqual({ ...expected, revision });
            expect(await stored(value)).toEqual(before);
          } else {
            if (expected.changed) revision += 1;
            expect(actual).toEqual({ ...expected, revision });
            state = expected.state;
            const persisted = await stored(value);
            expect(persisted.revision).toBe(revision);
            expect(persisted.participants).toEqual(expect.arrayContaining(state.participants));
            expect(persisted.participants).toHaveLength(state.participants.length);
            expect(persisted.stage).toEqual(state.stageSocketIds);
            expect(persisted.hands).toEqual(
              state.hands.flatMap((h) => [h.socketId, String(h.raisedAt)]),
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

  it('refreshes all live key TTLs only on changes', async () => {
    const value = prefix();
    const room = empty('WEBINAR');
    await repository.apply(value, room, join('host'));
    await repository.apply(value, room, join('a'));
    await repository.apply(value, room, hand('a'));
    for (const key of keys(value)) await redis.expire(key, 120);
    await repository.apply(value, room, join('new-socket', 'a'));
    await repository.apply(value, room, { type: 'leave', socketId: 'missing' });
    for (const key of keys(value)) expect(await redis.ttl(key)).toBeLessThanOrEqual(120);
    await repository.apply(value, room, patch({ isVideoOff: true }));
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
    const connection = new LiveConnection(redis.duplicate({ lazyConnect: true }), namespace);
    try {
      await connection.open();
      expect(connection.isReady()).toBe(true);
      expect(await redis.exists(...keys(own))).toBe(0);
      expect(await redis.hget(`${other}:participants`, 'host')).not.toBeNull();
      expect(await redis.get(`${other}:rev`)).toBe('1');
    } finally {
      connection.close();
    }
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
      const mute = await writes(patch({ isAudioMuted: true }));
      expect(mute.map((args) => args.slice(0, 3))).toEqual([
        ['HSET', `${value}:participants`, 'a'],
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
      const leave = await writes({ type: 'leave', socketId: 'a' });
      expect(leave.map((args) => args.slice(0, 3))).toEqual([
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
    expect(result.state.participants.find((p) => p.socketId === 'a')).toMatchObject({
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
      const ended = await repository.apply(value, room, { type: 'leave', socketId: 'host' });
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
      const retry = await repository.apply(value, room, { type: 'leave', socketId: 'guest' });
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
