import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ChatSendRequest, TransportBinding } from '@stageflow/shared';
import { LiveRepository } from '../live/live.repository';
import { liveKeys } from '../live/live.keys';
import { ChatRepository, chatKeys, type ChatAcceptLimits } from './chat.repository';

const limits: ChatAcceptLimits = {
  retention: 3,
  dedupCapacity: 3,
  ttlSeconds: 86_400,
  participantRateLimit: 10,
  roomRateLimit: 100,
  rateWindowMs: 10_000,
  userRateMaxFields: 3,
};
const binding = (participantId = 'host'): TransportBinding => ({
  participantId,
  socketId: `socket-${participantId}`,
  generation: 1,
});

describe('chat Lua loading', () => {
  it('uses its own seven keys and falls back only on NOSCRIPT', async () => {
    const response = JSON.stringify({ ok: false, error: 'stale_transport' });
    const redis = {
      evalsha: vi
        .fn()
        .mockRejectedValueOnce(new Error('NOSCRIPT missing'))
        .mockResolvedValue(response),
      eval: vi.fn().mockResolvedValue(response),
    };
    const repository = new ChatRepository(redis as unknown as Redis);
    await repository.accept(
      'sf:itest:cache',
      binding(),
      { requestId: randomUUID(), text: 'hello' },
      limits,
      1000,
    );
    expect(redis.eval.mock.calls[0]!.slice(1, 9)).toEqual([
      7,
      ...chatKeys('sf:itest:cache'),
      'sf:itest:cache:participants',
    ]);
    await repository.history('sf:itest:cache', binding(), { limit: 2 });
    expect(redis.eval).toHaveBeenCalledOnce();
    const ambiguous = new Error('Connection lost after write');
    redis.evalsha.mockRejectedValueOnce(ambiguous);
    await expect(repository.setPaused('sf:itest:cache', binding(), true, 86_400)).rejects.toBe(
      ambiguous,
    );
    expect(redis.eval).toHaveBeenCalledOnce();
  });
});

describe('chat scripts against Redis', () => {
  let redis: Redis;
  let repository: ChatRepository;
  let live: LiveRepository;
  const prefixes = new Set<string>();

  beforeAll(async () => {
    if (!process.env.REDIS_URL?.trim())
      throw new Error('REDIS_URL is required for chat integration tests.');
    redis = new Redis(process.env.REDIS_URL, {
      lazyConnect: true,
      connectTimeout: 3000,
      commandTimeout: 3000,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
    });
    redis.on('error', () => {
      /* connect/ping rejection fails this suite */
    });
    await redis.connect();
    expect(await redis.ping()).toBe('PONG');
    repository = new ChatRepository(redis);
    live = new LiveRepository(redis);
  });

  afterAll(async () => {
    try {
      if (redis?.status === 'ready') {
        for (const prefix of prefixes) await redis.del(...chatKeys(prefix), ...liveKeys(prefix));
      }
    } finally {
      redis?.disconnect();
    }
  });

  async function fixture() {
    const prefix = `sf:itest:${randomUUID()}`;
    prefixes.add(prefix);
    const room = { roomId: randomUUID(), hostId: 'host', mode: 'WEBINAR', status: 'LIVE' } as const;
    for (const id of ['host', 'guest', 'bot']) {
      const result = await live.apply(prefix, room, {
        type: 'join',
        participantId: id,
        socketId: `socket-${id}`,
        userId: id,
        displayName: `Name ${id}`,
        isAudioMuted: true,
        isVideoOff: true,
        isSyntheticBot: id === 'bot',
        joinedAt: 1000,
      });
      expect(result.ok).toBe(true);
    }
    const send = (
      id = 'host',
      overrides: Partial<ChatAcceptLimits> = {},
      now = 1000,
      request?: ChatSendRequest,
    ) =>
      repository.accept(
        prefix,
        binding(id),
        request ?? { requestId: randomUUID(), text: 'Hello\nroom' },
        { ...limits, ...overrides },
        now,
      );
    const history = (beforeSequence?: number, limit = 50) =>
      repository.history(prefix, binding(), { beforeSequence, limit });
    return { prefix, room, send, history };
  }

  it('assigns one ascending sequence and snapshots the name and role from actual stage rows', async () => {
    const f = await fixture();
    const sent = await Promise.all([f.send(), f.send('guest'), f.send('bot')]);
    expect(sent.every((result) => result.ok)).toBe(true);
    expect(sent.map((result) => result.ok && result.value.sequence)).toEqual([1, 2, 3]);
    expect(sent[0]).toEqual({
      ok: true,
      value: {
        sequence: 1,
        participantId: 'host',
        displayName: 'Name host',
        role: 'HOST',
        text: 'Hello\nroom',
        sentAt: 1000,
      },
    });
    expect(sent[1]).toMatchObject({ value: { participantId: 'guest', role: 'ATTENDEE' } });
    expect(await f.history()).toMatchObject({
      ok: true,
      value: {
        paused: false,
        oldestSequence: 1,
        latestSequence: 3,
        retentionGap: false,
        messages: sent.map((result) => result.ok && result.value),
      },
    });
    expect(liveKeys(f.prefix)).toHaveLength(9);
    expect(liveKeys(f.prefix)[5]).toBe(`${f.prefix}:broadcast`);
  });

  it('deduplicates concurrent retries, keeps the original identity, and spends no additional rate', async () => {
    const f = await fixture();
    const request = { requestId: randomUUID(), text: 'original' };
    const results = await Promise.all(
      Array.from({ length: 5 }, () => f.send('host', { participantRateLimit: 1 }, 1000, request)),
    );
    expect(results.every((result) => result.ok)).toBe(true);
    expect(results).toEqual(Array(5).fill(results[0]));
    expect(await redis.llen(`${f.prefix}:chat:messages`)).toBe(1);
    const row = (await live.readParticipant(f.prefix, 'host'))!;
    await redis.hset(
      `${f.prefix}:participants`,
      'host',
      JSON.stringify({ ...row, displayName: 'changed' }),
    );
    await repository.setPaused(f.prefix, binding(), true, limits.ttlSeconds);
    expect(await f.send('host', {}, 1001, { ...request, text: 'changed' })).toEqual(results[0]);
    expect(await redis.get(`${f.prefix}:chat:paused`)).toBe('1');
    expect(JSON.parse((await redis.hget(`${f.prefix}:chat:user-rate`, 'host'))!).count).toBe(1);
  });

  it('scopes duplicate ids to the participant and drops the oldest pair at its cap', async () => {
    const f = await fixture();
    const request = { requestId: randomUUID(), text: 'first' };
    await f.send('host', { dedupCapacity: 2 }, 1000, request);
    await f.send('guest', { dedupCapacity: 2 }, 1000, request);
    await f.send('host', { dedupCapacity: 2 });
    expect(await redis.hlen(`${f.prefix}:chat:dedup`)).toBe(2);
    expect(await f.send('host', { dedupCapacity: 2 }, 1001, request)).toMatchObject({
      value: { sequence: 4 },
    });
  });

  it('returns a consistent ascending page, trims retention, and exposes a lost cursor', async () => {
    const f = await fixture();
    expect(await f.history()).toEqual({
      ok: true,
      value: {
        paused: false,
        oldestSequence: null,
        latestSequence: null,
        retentionGap: false,
        messages: [],
      },
    });
    for (let index = 0; index < 4; index++) await f.send();
    const latest = await f.history(undefined, 2);
    expect(latest).toMatchObject({
      value: {
        oldestSequence: 2,
        latestSequence: 4,
        retentionGap: false,
        messages: [{ sequence: 3 }, { sequence: 4 }],
      },
    });
    expect(await f.history(4, 1)).toMatchObject({ value: { messages: [{ sequence: 3 }] } });
    expect(await f.history(2)).toMatchObject({ value: { retentionGap: false, messages: [] } });
    expect(await f.history(1)).toMatchObject({ value: { retentionGap: true, messages: [] } });
    expect(await redis.llen(`${f.prefix}:chat:messages`)).toBe(3);
  });

  it('pauses every sender and only lets a connected current host change pause', async () => {
    const f = await fixture();
    expect(await repository.setPaused(f.prefix, binding('guest'), true, limits.ttlSeconds)).toEqual(
      { ok: false, error: 'not_host' },
    );
    expect(
      await repository.setPaused(
        f.prefix,
        { ...binding(), generation: 2 },
        true,
        limits.ttlSeconds,
      ),
    ).toEqual({ ok: false, error: 'stale_transport' });
    expect(await repository.setPaused(f.prefix, binding(), true, limits.ttlSeconds)).toEqual({
      ok: true,
      value: { paused: true },
    });
    for (const id of ['host', 'guest', 'bot'])
      expect(await f.send(id)).toEqual({ ok: false, error: 'chat_paused' });
    expect(await f.history()).toMatchObject({ value: { paused: true, messages: [] } });
    await repository.setPaused(f.prefix, binding(), false, limits.ttlSeconds);
    expect((await f.send('bot')).ok).toBe(true);
  });

  it('orders concurrent pause and send calls atomically', async () => {
    const f = await fixture();
    const [pause, send] = await Promise.all([
      repository.setPaused(f.prefix, binding(), true, limits.ttlSeconds),
      f.send('guest'),
    ]);
    expect(pause.ok).toBe(true);
    expect(send).toEqual({ ok: false, error: 'chat_paused' });
    expect(await redis.llen(`${f.prefix}:chat:messages`)).toBe(0);
  });

  it('rejects stale sockets, generations, suspended, missing and wrong-room memberships before any write', async () => {
    const f = await fixture();
    for (const transport of [
      { ...binding(), generation: 2 },
      { ...binding(), socketId: 'old' },
      binding('missing'),
    ]) {
      expect(
        await repository.accept(
          f.prefix,
          transport,
          { requestId: randomUUID(), text: 'No' },
          limits,
          1000,
        ),
      ).toEqual({ ok: false, error: 'stale_transport' });
      expect(await repository.history(f.prefix, transport, { limit: 50 })).toEqual({
        ok: false,
        error: 'stale_transport',
      });
    }
    const wrong = await fixture();
    expect(
      await repository.accept(
        wrong.prefix,
        { ...binding(), participantId: 'elsewhere' },
        { requestId: randomUUID(), text: 'No' },
        limits,
        1000,
      ),
    ).toEqual({ ok: false, error: 'stale_transport' });
    const row = (await live.readParticipant(f.prefix, 'host'))!;
    await redis.hset(
      `${f.prefix}:participants`,
      'host',
      JSON.stringify({ ...row, presence: 'suspended', socketId: null }),
    );
    expect(await f.send()).toEqual({ ok: false, error: 'stale_transport' });
    expect(await repository.setPaused(f.prefix, binding(), true, limits.ttlSeconds)).toEqual({
      ok: false,
      error: 'stale_transport',
    });
    expect(await redis.exists(...chatKeys(f.prefix))).toBe(0);
  });

  it('enforces participant and room rates without spending a rejected accept and resets at the boundary', async () => {
    const f = await fixture();
    const caps = { participantRateLimit: 1, roomRateLimit: 2 };
    expect((await f.send('host', caps)).ok).toBe(true);
    expect(await f.send('host', caps)).toEqual({ ok: false, error: 'chat_rate_limited' });
    expect((await f.send('guest', caps)).ok).toBe(true);
    expect(await f.send('bot', caps)).toEqual({ ok: false, error: 'chat_rate_limited' });
    expect(await redis.hget(`${f.prefix}:chat:user-rate`, 'bot')).toBeNull();
    expect(await redis.get(`${f.prefix}:chat:seq`)).toBe('2');
    expect(await f.send('host', caps, 10_999)).toEqual({ ok: false, error: 'chat_rate_limited' });
    expect(await f.send('host', caps, 11_000)).toMatchObject({ value: { sequence: 3 } });
    expect(JSON.parse((await redis.get(`${f.prefix}:chat:room-rate`))!).count).toBe(1);
  });

  it('does not evict an active user-rate field at capacity and reclaims expired fields', async () => {
    const f = await fixture();
    const caps = { userRateMaxFields: 1 };
    await f.send('host', caps);
    const original = await redis.hgetall(`${f.prefix}:chat:user-rate`);
    expect(await f.send('guest', caps)).toEqual({ ok: false, error: 'chat_busy' });
    expect(await redis.hgetall(`${f.prefix}:chat:user-rate`)).toEqual(original);
    expect(await redis.get(`${f.prefix}:chat:seq`)).toBe('1');
    expect((await f.send('host', caps)).ok).toBe(true);
    expect((await f.send('guest', caps, 11_000)).ok).toBe(true);
    expect(Object.keys(await redis.hgetall(`${f.prefix}:chat:user-rate`))).toEqual(['guest']);
  });

  it('refreshes idle TTLs on chat writes, leaves stage expiry alone, and deletes chat twice safely', async () => {
    const f = await fixture();
    await redis.expire(`${f.prefix}:participants`, 120);
    await repository.setPaused(f.prefix, binding(), false, limits.ttlSeconds);
    await f.send();
    for (const key of chatKeys(f.prefix)) {
      expect(await redis.ttl(key)).toBeGreaterThanOrEqual(86_399);
      await redis.expire(key, 20);
    }
    await repository.setPaused(f.prefix, binding(), true, limits.ttlSeconds);
    for (const key of chatKeys(f.prefix))
      expect(await redis.ttl(key)).toBeGreaterThanOrEqual(86_399);
    expect(await redis.ttl(`${f.prefix}:participants`)).toBeGreaterThanOrEqual(119);
    expect(await redis.ttl(`${f.prefix}:participants`)).toBeLessThanOrEqual(120);
    await repository.delete(f.prefix);
    await repository.delete(f.prefix);
    expect(await redis.exists(...chatKeys(f.prefix))).toBe(0);
    expect(await live.readParticipant(f.prefix, 'host')).not.toBeNull();
  });
});
