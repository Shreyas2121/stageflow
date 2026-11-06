import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { parseQaSubmit, type QaSubmitRequest, type TransportBinding } from '@stageflow/shared';
import { LiveRepository } from '../live/live.repository';
import { liveKeys } from '../live/live.keys';
import { chatKeys } from '../chat/chat.repository';
import { QaRepository, qaKeys, type QaLimits } from './qa.repository';

const limits: QaLimits = {
  boardMax: 100,
  ttlSeconds: 86_400,
  submitParticipantLimit: 5,
  submitRoomLimit: 30,
  voteParticipantLimit: 20,
  voteRoomLimit: 100,
  rateWindowMs: 10_000,
  userRateMaxFields: 1_000,
};
const binding = (participantId = 'host'): TransportBinding => ({
  participantId,
  socketId: `socket-${participantId}`,
  generation: 1,
});

it('loads nine independent keys, falls back only on NOSCRIPT, and never replays ambiguous writes', async () => {
  const response = JSON.stringify({ ok: false, error: 'stale_transport' });
  const redis = {
    evalsha: vi
      .fn()
      .mockRejectedValueOnce(new Error('NOSCRIPT missing'))
      .mockResolvedValue(response),
    eval: vi.fn().mockResolvedValue(response),
  };
  const repository = new QaRepository(redis as unknown as Redis);
  await repository.submit('sf:itest:cache', binding(), { text: 'Hi' }, limits, 1000);
  expect(redis.eval.mock.calls[0]!.slice(1, 11)).toEqual([
    9,
    ...qaKeys('sf:itest:cache'),
    'sf:itest:cache:participants',
  ]);
  await repository.state('sf:itest:cache', binding());
  expect(redis.eval).toHaveBeenCalledOnce();
  const ambiguous = new Error('Connection lost after write');
  redis.evalsha.mockRejectedValueOnce(ambiguous);
  await expect(repository.vote('sf:itest:cache', binding(), '1', limits, 1000)).rejects.toBe(
    ambiguous,
  );
  expect(redis.eval).toHaveBeenCalledOnce();
  redis.evalsha.mockResolvedValueOnce(1);
  await expect(repository.delete('sf:itest:cache')).rejects.toThrow(
    'Invalid Redis question result',
  );
});

describe('Q&A scripts against Redis', () => {
  let redis: Redis;
  let repository: QaRepository;
  let live: LiveRepository;
  const prefixes = new Set<string>();
  beforeAll(async () => {
    if (!process.env.REDIS_URL?.trim())
      throw new Error('REDIS_URL is required for Q&A integration tests.');
    redis = new Redis(process.env.REDIS_URL, {
      lazyConnect: true,
      connectTimeout: 3000,
      commandTimeout: 3000,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
    });
    redis.on('error', () => {
      /* connection rejection fails the suite */
    });
    await redis.connect();
    expect(await redis.ping()).toBe('PONG');
    repository = new QaRepository(redis);
    live = new LiveRepository(redis);
  });
  afterAll(async () => {
    try {
      if (redis?.status === 'ready')
        for (const prefix of prefixes) {
          await repository.delete(prefix);
          await redis.del(...liveKeys(prefix), ...chatKeys(prefix));
        }
    } finally {
      redis?.disconnect();
    }
  });

  async function fixture(
    status: 'LIVE' | 'SCHEDULED' = 'LIVE',
    mode: 'WEBINAR' | 'MEETING' = 'WEBINAR',
  ) {
    const prefix = `sf:itest:${randomUUID()}`;
    prefixes.add(prefix);
    const room = { roomId: randomUUID(), hostId: 'host', mode, status } as const;
    for (const id of ['host', 'guest', 'other', 'bot']) {
      if (status === 'SCHEDULED' && id === 'bot') continue;
      expect(
        (
          await live.apply(prefix, room, {
            type: 'join',
            participantId: id,
            socketId: `socket-${id}`,
            userId: id,
            displayName: `Name ${id}`,
            isAudioMuted: true,
            isVideoOff: true,
            isSyntheticBot: id === 'bot',
            joinedAt: 1000,
          })
        ).ok,
      ).toBe(true);
    }
    const submit = (
      id = 'host',
      overrides: Partial<QaLimits> = {},
      now = 1000,
      request: QaSubmitRequest = { text: 'Hello' },
    ) => repository.submit(prefix, binding(id), request, { ...limits, ...overrides }, now);
    const vote = (questionId = '1', id = 'guest', overrides: Partial<QaLimits> = {}, now = 1000) =>
      repository.vote(prefix, binding(id), questionId, { ...limits, ...overrides }, now);
    const state = (id = 'host') => repository.state(prefix, binding(id));
    return { prefix, room, submit, vote, state };
  }

  async function seedQuestions(prefix: string, count: number) {
    for (let i = 1; i <= count; i++)
      await redis.hset(
        `${prefix}:qa:questions`,
        String(i),
        JSON.stringify({
          id: String(i),
          text: `Question ${i}`,
          authorName: 'Name host',
          authorParticipantId: 'host',
          createdAt: 1000,
        }),
      );
    await redis.set(`${prefix}:qa:seq`, count);
  }

  it('lets the host feature, replace, clear, close, dismiss and reopen without losing the board', async () => {
    const f = await fixture();
    await f.submit();
    await f.submit('guest');
    await f.vote('1');
    expect(await repository.feature(f.prefix, binding(), '1', limits.ttlSeconds)).toMatchObject({
      value: {
        featured: { questionId: '1', text: 'Hello', authorName: 'Name host' },
        votedQuestionIds: [],
      },
    });
    expect(await repository.feature(f.prefix, binding(), '2', limits.ttlSeconds)).toMatchObject({
      value: {
        featured: { questionId: '2', text: 'Hello', authorName: 'Name guest' },
      },
    });
    const closed = await repository.setSubmissions(f.prefix, binding(), false, limits.ttlSeconds);
    expect(closed).toMatchObject({
      value: {
        submissionsOpen: false,
        featured: { questionId: '2' },
        questions: [{ id: '1', voteCount: 1 }, { id: '2' }],
      },
    });
    expect(await redis.get(`${f.prefix}:qa:submissions`)).toBe('0');
    for (const id of ['host', 'guest'])
      expect(await f.submit(id)).toEqual({ ok: false, error: 'qa_closed' });
    expect((await f.vote('2')).ok).toBe(true);
    expect(await repository.clearFeature(f.prefix, binding(), limits.ttlSeconds)).toMatchObject({
      value: { featured: null, submissionsOpen: false },
    });
    expect(await repository.clearFeature(f.prefix, binding(), limits.ttlSeconds)).toMatchObject({
      value: { featured: null },
    });
    await repository.feature(f.prefix, binding(), '2', limits.ttlSeconds);
    expect(await repository.dismiss(f.prefix, binding(), '1', limits.ttlSeconds)).toMatchObject({
      value: { featured: { questionId: '2' }, questions: [{ id: '2' }] },
    });
    expect(await redis.exists(`${f.prefix}:qa:votes:1`)).toBe(0);
    expect(await repository.dismiss(f.prefix, binding(), '2', limits.ttlSeconds)).toMatchObject({
      value: { featured: null, questions: [], votedQuestionIds: [] },
    });
    expect(await redis.exists(`${f.prefix}:qa:votes:2`, `${f.prefix}:qa:featured`)).toBe(0);
    expect(
      await repository.setSubmissions(f.prefix, binding(), true, limits.ttlSeconds),
    ).toMatchObject({ value: { submissionsOpen: true } });
    expect(await redis.get(`${f.prefix}:qa:submissions`)).toBe('1');
    expect(await f.submit()).toMatchObject({ value: { questions: [{ id: '3' }] } });
  });

  it('requires the current connected host for all four commands, including against a closed board', async () => {
    const f = await fixture();
    await f.submit();
    await f.vote();
    await repository.setSubmissions(f.prefix, binding(), false, limits.ttlSeconds);
    const guest = (await live.readParticipant(f.prefix, 'guest'))!;
    const attempts = (member: TransportBinding) => [
      () => repository.dismiss(f.prefix, member, '1', limits.ttlSeconds),
      () => repository.feature(f.prefix, member, '1', limits.ttlSeconds),
      () => repository.clearFeature(f.prefix, member, limits.ttlSeconds),
      () => repository.setSubmissions(f.prefix, member, true, limits.ttlSeconds),
    ];
    const keys = [...qaKeys(f.prefix), `${f.prefix}:qa:votes:1`];
    const before = await Promise.all(keys.map((key) => redis.dump(key)));
    for (const role of ['SPEAKER', 'ATTENDEE', 'WAITING'] as const) {
      await redis.hset(`${f.prefix}:participants`, 'guest', JSON.stringify({ ...guest, role }));
      for (const attempt of attempts(binding('guest')))
        expect(await attempt()).toEqual({ ok: false, error: 'not_host' });
    }
    for (const attempt of attempts(binding('bot')))
      expect(await attempt()).toEqual({ ok: false, error: 'not_host' });
    for (const member of [
      binding('missing'),
      { ...binding(), generation: 2 },
      { ...binding(), socketId: 'old' },
    ])
      for (const attempt of attempts(member))
        expect(await attempt()).toEqual({ ok: false, error: 'stale_transport' });
    const host = (await live.readParticipant(f.prefix, 'host'))!;
    await redis.hset(
      `${f.prefix}:participants`,
      'host',
      JSON.stringify({ ...host, presence: 'suspended', socketId: null }),
    );
    for (const attempt of attempts(binding()))
      expect(await attempt()).toEqual({ ok: false, error: 'stale_transport' });
    expect(await Promise.all(keys.map((key) => redis.dump(key)))).toEqual(before);
  });

  it('rejects missing ids before writes or TTL refresh and dismiss frees a full board slot', async () => {
    const f = await fixture();
    await seedQuestions(f.prefix, 100);
    await redis.set(`${f.prefix}:qa:featured`, '1');
    await redis.expire(`${f.prefix}:qa:questions`, 20);
    const before = await Promise.all(qaKeys(f.prefix).map((key) => redis.dump(key)));
    for (const method of ['dismiss', 'feature'] as const) {
      expect(await repository[method](f.prefix, binding(), '101', limits.ttlSeconds)).toEqual({
        ok: false,
        error: 'qa_missing',
      });
      expect(await Promise.all(qaKeys(f.prefix).map((key) => redis.dump(key)))).toEqual(before);
      expect(await redis.ttl(`${f.prefix}:qa:questions`)).toBeLessThanOrEqual(20);
    }
    expect(await f.submit()).toEqual({ ok: false, error: 'qa_full' });
    await repository.dismiss(f.prefix, binding(), '1', limits.ttlSeconds);
    expect(await f.submit()).toMatchObject({
      value: { questions: expect.arrayContaining([expect.objectContaining({ id: '101' })]) },
    });
  });

  it('atomically chooses one of two concurrent features and returns the state of each command', async () => {
    const f = await fixture();
    await f.submit();
    await f.submit('guest');
    const results = await Promise.all(
      ['1', '2'].map((id) => repository.feature(f.prefix, binding(), id, limits.ttlSeconds)),
    );
    expect(results.map((r) => r.ok && r.value.featured?.questionId)).toEqual(['1', '2']);
    const stored = await redis.get(`${f.prefix}:qa:featured`);
    expect(['1', '2']).toContain(stored);
    expect(await f.state()).toMatchObject({ value: { featured: { questionId: stored } } });
    expect(await redis.type(`${f.prefix}:qa:featured`)).toBe('string');
  });

  it('supports a pre-start host and a meeting host without writing stage, broadcast or chat keys', async () => {
    for (const [status, mode] of [
      ['SCHEDULED', 'WEBINAR'],
      ['LIVE', 'MEETING'],
    ] as const) {
      const f = await fixture(status, mode);
      await f.submit();
      const keys = [...liveKeys(f.prefix), ...chatKeys(f.prefix)];
      const before = await Promise.all(keys.map((key) => redis.dump(key)));
      expect(await repository.feature(f.prefix, binding(), '1', limits.ttlSeconds)).toMatchObject({
        value: { featured: { questionId: '1' } },
      });
      await repository.setSubmissions(f.prefix, binding(), false, limits.ttlSeconds);
      await repository.clearFeature(f.prefix, binding(), limits.ttlSeconds);
      await repository.dismiss(f.prefix, binding(), '1', limits.ttlSeconds);
      expect(await Promise.all(keys.map((key) => redis.dump(key)))).toEqual(before);
      expect(await redis.get(`${f.prefix}:broadcast`)).toBeNull();
    }
  });

  it('refreshes retained Q&A TTLs on every moderation command without refreshing membership', async () => {
    const f = await fixture();
    await f.submit();
    await f.submit();
    await f.vote('1');
    await f.vote('2');
    await redis.expire(`${f.prefix}:participants`, 120);
    for (const command of [
      () => repository.setSubmissions(f.prefix, binding(), false, limits.ttlSeconds),
      () => repository.feature(f.prefix, binding(), '1', limits.ttlSeconds),
      () => repository.dismiss(f.prefix, binding(), '2', limits.ttlSeconds),
      () => repository.clearFeature(f.prefix, binding(), limits.ttlSeconds),
    ]) {
      const keys = [
        ...qaKeys(f.prefix),
        ...(await redis.hkeys(`${f.prefix}:qa:questions`)).map(
          (id) => `${f.prefix}:qa:votes:${id}`,
        ),
      ];
      for (const key of keys) await redis.expire(key, 20);
      expect((await command()).ok).toBe(true);
      for (const key of keys)
        if (await redis.exists(key)) expect(await redis.ttl(key)).toBeGreaterThanOrEqual(86_399);
    }
    expect(await redis.ttl(`${f.prefix}:participants`)).toBeGreaterThanOrEqual(119);
    expect(await redis.ttl(`${f.prefix}:participants`)).toBeLessThanOrEqual(120);
  });

  it('returns empty arrays without creating Q&A keys, including for the pre-start host', async () => {
    const f = await fixture('SCHEDULED');
    expect(await f.state()).toEqual({
      ok: true,
      value: {
        submissionsOpen: true,
        featured: null,
        questions: [],
        votedQuestionIds: [],
      },
    });
    expect(await redis.exists(...qaKeys(f.prefix))).toBe(0);
    expect((await f.submit()).ok).toBe(true);
    expect(await f.submit('guest')).toEqual({ ok: false, error: 'qa_not_allowed' });
  });

  it('copies membership identity, gives concurrent questions distinct ids, and records one vote per member', async () => {
    const f = await fixture();
    const request = { text: '<b>hi</b>', authorName: 'forged', participantId: 'forged' };
    expect(parseQaSubmit(request)).toEqual({ ok: false, error: 'invalid_payload' });
    const [a, b] = await Promise.all([f.submit('host', {}, 1000, request), f.submit('guest')]);
    expect(a).toMatchObject({
      value: {
        questions: [
          {
            id: '1',
            text: '<b>hi</b>',
            authorName: 'Name host',
            authorParticipantId: 'host',
            voteCount: 0,
          },
        ],
      },
    });
    expect(b).toMatchObject({
      value: { questions: [{ id: '1' }, { id: '2', authorName: 'Name guest' }] },
    });
    const results = await Promise.all(Array.from({ length: 5 }, () => f.vote()));
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results[4]).toMatchObject({
      value: {
        questions: [
          { id: '1', voteCount: 1 },
          { id: '2', voteCount: 0 },
        ],
        votedQuestionIds: ['1'],
      },
    });
    expect(await redis.scard(`${f.prefix}:qa:votes:1`)).toBe(1);
    expect(JSON.parse((await redis.hget(`${f.prefix}:qa:vote-user-rate`, 'guest'))!).count).toBe(1);
    expect(await f.vote('1', 'host')).toMatchObject({
      value: {
        questions: [
          { id: '1', voteCount: 2 },
          { id: '2', voteCount: 0 },
        ],
      },
    });
    expect(await f.state('other')).toMatchObject({ value: { votedQuestionIds: [] } });
  });

  it('does not write or expire any of the ten live keys or chat keys', async () => {
    const f = await fixture();
    const keys = [...liveKeys(f.prefix), ...chatKeys(f.prefix)];
    const before = await Promise.all(keys.map((key) => redis.dump(key)));
    await redis.expire(`${f.prefix}:participants`, 120);
    const ttl = await redis.ttl(`${f.prefix}:participants`);
    await f.submit();
    await f.vote();
    await f.state();
    expect(await Promise.all(keys.map((key) => redis.dump(key)))).toEqual(before);
    expect(await redis.ttl(`${f.prefix}:participants`)).toBeGreaterThanOrEqual(ttl - 1);
    expect(await redis.ttl(`${f.prefix}:participants`)).toBeLessThanOrEqual(ttl);
    expect(liveKeys(f.prefix)).toHaveLength(10);
  });

  it('checks binding and eligibility before closed/full/rate and writes nothing on refusal', async () => {
    const f = await fixture();
    const row = (await live.readParticipant(f.prefix, 'other'))!;
    await redis.hset(
      `${f.prefix}:participants`,
      'other',
      JSON.stringify({ ...row, role: 'WAITING' }),
    );
    for (const member of [
      binding('bot'),
      binding('other'),
      binding('missing'),
      { ...binding(), socketId: 'old' },
      { ...binding(), generation: 2 },
    ]) {
      const error = ['bot', 'other'].includes(member.participantId)
        ? 'qa_not_allowed'
        : 'stale_transport';
      expect(await repository.submit(f.prefix, member, { text: 'No' }, limits, 1000)).toEqual({
        ok: false,
        error,
      });
      expect(await repository.vote(f.prefix, member, '1', limits, 1000)).toEqual({
        ok: false,
        error,
      });
      expect(await repository.state(f.prefix, member)).toEqual({ ok: false, error });
    }
    await redis.hset(
      `${f.prefix}:participants`,
      'host',
      JSON.stringify({ ...row, presence: 'suspended', socketId: null }),
    );
    expect(await f.submit()).toEqual({ ok: false, error: 'stale_transport' });
    expect(await redis.exists(...qaKeys(f.prefix))).toBe(0);
  });

  it('rejects question 101 before rate, frees a dismissed slot, and never reuses an id', async () => {
    const f = await fixture();
    const unlimited = { submitParticipantLimit: 200, submitRoomLimit: 200 };
    for (let i = 0; i < 100; i++) expect((await f.submit('host', unlimited)).ok).toBe(true);
    expect(await f.submit()).toEqual({ ok: false, error: 'qa_full' });
    expect(await redis.get(`${f.prefix}:qa:seq`)).toBe('100');
    await redis.hdel(`${f.prefix}:qa:questions`, '1');
    expect(await f.submit('host', unlimited)).toMatchObject({
      value: { questions: expect.arrayContaining([expect.objectContaining({ id: '101' })]) },
    });
    await redis.set(`${f.prefix}:qa:submissions`, '0');
    expect(await f.submit()).toEqual({ ok: false, error: 'qa_closed' });
    expect((await f.vote('2')).ok).toBe(true);
    expect(await f.state()).toMatchObject({ value: { submissionsOpen: false } });
  });

  it('enforces five participant submissions and thirty room submissions, with separate vote budgets', async () => {
    const f = await fixture();
    for (let i = 0; i < 5; i++) expect((await f.submit()).ok).toBe(true);
    expect(await f.submit()).toEqual({ ok: false, error: 'qa_rate_limited' });
    expect((await f.vote('1', 'host')).ok).toBe(true);
    expect(await f.submit('host', {}, 10_999)).toEqual({ ok: false, error: 'qa_rate_limited' });
    expect((await f.submit('host', {}, 11_000)).ok).toBe(true);
    const g = await fixture();
    for (let i = 0; i < 30; i++)
      expect((await g.submit('host', { submitParticipantLimit: 100 })).ok).toBe(true);
    expect(await g.submit('guest')).toEqual({ ok: false, error: 'qa_rate_limited' });
    expect(await redis.hget(`${g.prefix}:qa:submit-user-rate`, 'guest')).toBeNull();
    expect(await redis.get(`${g.prefix}:qa:seq`)).toBe('30');
  });

  it('enforces twenty participant votes and one hundred room votes; duplicates and missing ids spend no rate', async () => {
    const f = await fixture();
    await seedQuestions(f.prefix, 100);
    for (let i = 1; i <= 20; i++) expect((await f.vote(String(i))).ok).toBe(true);
    expect(await f.vote('21')).toEqual({ ok: false, error: 'qa_vote_rate_limited' });
    expect((await f.vote('1')).ok).toBe(true);
    expect(await f.vote('101')).toEqual({ ok: false, error: 'qa_missing' });
    expect(await f.vote('21', 'guest', {}, 10_999)).toEqual({
      ok: false,
      error: 'qa_vote_rate_limited',
    });
    expect((await f.vote('21', 'guest', {}, 11_000)).ok).toBe(true);
    const g = await fixture();
    await seedQuestions(g.prefix, 100);
    for (let i = 1; i <= 100; i++)
      expect((await g.vote(String(i), 'host', { voteParticipantLimit: 100 })).ok).toBe(true);
    expect(await g.vote('1', 'guest')).toEqual({ ok: false, error: 'qa_vote_rate_limited' });
    expect(await redis.hget(`${g.prefix}:qa:vote-user-rate`, 'guest')).toBeNull();
    expect(await redis.scard(`${g.prefix}:qa:votes:1`)).toBe(1);
    expect((await g.vote('1', 'host')).ok).toBe(true);
  });

  it('bounds both participant rate hashes without evicting active counters and reclaims expired ones', async () => {
    const f = await fixture();
    const caps = { userRateMaxFields: 1 };
    await f.submit('host', caps);
    expect(await f.submit('guest', caps)).toEqual({ ok: false, error: 'qa_busy' });
    expect(Object.keys(await redis.hgetall(`${f.prefix}:qa:submit-user-rate`))).toEqual(['host']);
    expect((await f.submit('guest', caps, 11_000)).ok).toBe(true);
    expect(Object.keys(await redis.hgetall(`${f.prefix}:qa:submit-user-rate`))).toEqual(['guest']);
    await f.vote('1', 'host', caps);
    expect(await f.vote('1', 'guest', caps)).toEqual({ ok: false, error: 'qa_busy' });
    expect((await f.vote('1', 'guest', caps, 11_000)).ok).toBe(true);
    expect(Object.keys(await redis.hgetall(`${f.prefix}:qa:vote-user-rate`))).toEqual(['guest']);
  });

  it('sorts by votes, creation time, and numeric id, and returns one consistent feature', async () => {
    const f = await fixture();
    await seedQuestions(f.prefix, 10);
    const earlier = JSON.parse((await redis.hget(`${f.prefix}:qa:questions`, '9'))!);
    await redis.hset(
      `${f.prefix}:qa:questions`,
      '9',
      JSON.stringify({ ...earlier, createdAt: 999 }),
    );
    await redis.set(`${f.prefix}:qa:featured`, '10');
    await f.vote('10');
    expect(await f.state('guest')).toMatchObject({
      value: {
        featured: { questionId: '10', text: 'Question 10', authorName: 'Name host' },
        votedQuestionIds: ['10'],
        questions: [
          { id: '10', voteCount: 1 },
          { id: '9' },
          { id: '1' },
          { id: '2' },
          { id: '3' },
          { id: '4' },
          { id: '5' },
          { id: '6' },
          { id: '7' },
          { id: '8' },
        ],
      },
    });
    await redis.hdel(`${f.prefix}:qa:questions`, '10');
    await redis.del(`${f.prefix}:qa:votes:10`);
    expect(await f.state()).toMatchObject({ value: { featured: null } });
    expect(await redis.get(`${f.prefix}:qa:featured`)).toBeNull();
    await redis.set(`${f.prefix}:qa:seq`, '9007199254740991');
    await f.submit();
    await f.submit();
    const result = await f.state();
    expect(result).toMatchObject({
      value: {
        questions: expect.arrayContaining([
          expect.objectContaining({ id: '9007199254740992' }),
          expect.objectContaining({ id: '9007199254740993' }),
        ]),
      },
    });
    expect(result.ok && result.value.questions.slice(-2).map((q) => q.id)).toEqual([
      '9007199254740992',
      '9007199254740993',
    ]);
  });

  it('keeps votes and rate buckets on the participant id across a resumed transport', async () => {
    const f = await fixture();
    for (let i = 0; i < 5; i++) await f.submit();
    await f.vote('1', 'host');
    const participant = (await live.readParticipant(f.prefix, 'host'))!;
    const resumed = { participantId: 'host', socketId: 'replacement', generation: 2 };
    await redis.hset(
      `${f.prefix}:participants`,
      'host',
      JSON.stringify({ ...participant, socketId: resumed.socketId, connectionGeneration: 2 }),
    );
    expect(await f.state()).toEqual({ ok: false, error: 'stale_transport' });
    expect(await repository.vote(f.prefix, resumed, '1', limits, 1000)).toMatchObject({
      value: { votedQuestionIds: ['1'] },
    });
    expect(await redis.scard(`${f.prefix}:qa:votes:1`)).toBe(1);
    expect(
      await repository.submit(f.prefix, resumed, { text: 'No new bucket' }, limits, 1000),
    ).toEqual({ ok: false, error: 'qa_rate_limited' });
  });

  it('refreshes fixed and all retained vote-set TTLs and deletes only its own Q&A state idempotently', async () => {
    const f = await fixture(),
      other = await fixture();
    await f.submit();
    await f.submit();
    await f.vote('1');
    await f.vote('2');
    await other.submit();
    await redis.set(`${f.prefix}:qa:featured`, '1');
    await redis.set(`${f.prefix}:qa:submissions`, '1');
    const keys = [...qaKeys(f.prefix), `${f.prefix}:qa:votes:1`, `${f.prefix}:qa:votes:2`];
    for (const key of keys) await redis.expire(key, 20);
    await f.vote('1');
    for (const key of keys) expect(await redis.ttl(key)).toBeGreaterThanOrEqual(86_399);
    await redis.set(`${f.prefix}:chat:paused`, '1');
    await repository.delete(f.prefix);
    await repository.delete(f.prefix);
    expect(await redis.exists(...keys)).toBe(0);
    expect(await live.readParticipant(f.prefix, 'host')).not.toBeNull();
    expect(await redis.get(`${f.prefix}:chat:paused`)).toBe('1');
    expect(await other.state()).toMatchObject({ value: { questions: [{ id: '1' }] } });
  });
});
