import { Logger } from '@nestjs/common';
import { afterEach, expect, it, vi } from 'vitest';
import {
  applyStageCommand,
  QA_MAX_QUEUED_OPERATIONS,
  type LiveState,
  type RoomSnapshot,
} from '@stageflow/shared';
import { QaService, type QaTransport } from './qa.service';
import type { QaRepository, QaStoreState } from './qa.repository';
import {
  LiveService,
  type LiveSession,
  type LiveTransport,
  type BroadcastControl,
} from '../live/live.service';
import type { LiveRepository } from '../live/live.repository';
import { SerializedOperations } from '../live/serialized-operations';

const board: QaStoreState = {
  submissionsOpen: true,
  featured: null,
  questions: [
    {
      id: '1',
      text: 'Hello',
      authorName: 'host',
      authorParticipantId: 'host',
      createdAt: 1000,
      voteCount: 1,
    },
  ],
  votedQuestionIds: ['1'],
};
const publicBoard = {
  submissionsOpen: board.submissionsOpen,
  featured: board.featured,
  questions: board.questions,
};
const request = { text: 'Hello' };
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
const disposers: (() => Promise<void> | void)[] = [];
const moderationMethods = ['dismiss', 'feature', 'clearFeature', 'setSubmissions'] as const;
function moderate(
  qa: QaService,
  method: (typeof moderationMethods)[number],
  client: LiveSession,
  transport: QaTransport,
) {
  if (method === 'clearFeature') return qa.clearFeature(client, transport);
  if (method === 'setSubmissions') return qa.setSubmissions(client, false, transport);
  return qa[method](client, '1', transport);
}
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
  vi.restoreAllMocks();
});

async function fixture(
  status: 'LIVE' | 'SCHEDULED' = 'LIVE',
  mode: 'WEBINAR' | 'MEETING' = 'WEBINAR',
) {
  let state: LiveState = {
    roomId: 'room',
    hostId: 'host',
    mode,
    status,
    participants: [],
    stageParticipantIds: [],
    waitingParticipantIds: [],
    hands: [],
    resumeDigests: {},
    deadlines: {},
  };
  let revision = 0;
  const stage = {
    readBroadcast: vi.fn(async () => (mode === 'WEBINAR' ? 'broadcast' : null)),
    tryBeginBroadcast: vi.fn(),
    apply: vi.fn<LiveRepository['apply']>(async (_prefix, _room, command) => {
      const result = applyStageCommand(state, command);
      if (result.ok) {
        state = result.state;
        if (result.changed) revision++;
      }
      return { ...result, revision };
    }),
    readParticipant: vi.fn<LiveRepository['readParticipant']>(async (prefix, id) =>
      prefix === 'sf_test:room:room'
        ? (state.participants.find((p) => p.participantId === id) ?? null)
        : null,
    ),
    readStage: vi.fn(async () => state.stageParticipantIds),
    readConnectedStage: vi.fn(async () => state.stageParticipantIds),
    readSocket: vi.fn<LiveRepository['readSocket']>(
      async (_prefix, id) =>
        state.participants.find((p) => p.participantId === id)?.socketId ?? null,
    ),
    deleteRoom: vi.fn(async () => {}),
  };
  const repository = {
    submit: vi.fn<QaRepository['submit']>(async () => ({ ok: true, value: board })),
    vote: vi.fn<QaRepository['vote']>(async () => ({ ok: true, value: board })),
    state: vi.fn<QaRepository['state']>(async () => ({ ok: true, value: board })),
    delete: vi.fn<QaRepository['delete']>(async () => {}),
    dismiss: vi.fn<QaRepository['dismiss']>(async () => ({ ok: true, value: board })),
    feature: vi.fn<QaRepository['feature']>(async () => ({ ok: true, value: board })),
    clearFeature: vi.fn<QaRepository['clearFeature']>(async () => ({ ok: true, value: board })),
    setSubmissions: vi.fn<QaRepository['setSubmissions']>(async () => ({ ok: true, value: board })),
  };
  const broadcast = {
    snapshot: vi.fn(async () =>
      mode === 'WEBINAR'
        ? {
            id: 'broadcast',
            status: 'LIVE' as const,
            playlistUrl: '/live/index.m3u8',
            errorMessage: null,
          }
        : null,
    ),
    start: vi.fn(),
    stopRoom: vi.fn(async () => {}),
    failInterrupted: vi.fn(),
  };
  const snapshots: RoomSnapshot[] = [];
  const transport: LiveTransport = {
    join: vi.fn(async () => {}),
    leave: vi.fn(async () => {}),
    publish: vi.fn((snapshot) => {
      snapshots.push(snapshot);
    }),
    forceMute: vi.fn(),
    peer: () => undefined,
    end: vi.fn(),
  };
  const availability = {
    ready: true,
    isReady() {
      return this.ready;
    },
  };
  const operations = new SerializedOperations();
  const live = new LiveService(
    {
      getById: async () => ({ id: 'room', hostId: 'host', mode, status }) as never,
      startScheduled: vi.fn(async () => true),
      cancelScheduled: vi.fn(async () => true),
      end: vi.fn(async () => {}),
    },
    stage,
    operations,
    availability,
    'sf_test',
    { service: broadcast, repository: stage } as unknown as BroadcastControl,
    undefined,
    undefined,
    repository,
  );
  const client = (id: string): LiveSession => ({
    id: `socket-${id}`,
    user: { id, displayName: id },
    connected: true,
    room: undefined,
  });
  const host = client('host'),
    guest = client('guest');
  for (const member of [host, guest])
    expect(
      await live.join(
        member,
        { roomId: 'room', isAudioMuted: true, isVideoOff: true, isSyntheticBot: false },
        transport,
        member.user.id,
      ),
    ).toEqual({ ok: true });
  const qa = new QaService(repository, live, 'sf_test', () => 1000);
  const delivery: QaTransport = { state: vi.fn() };
  disposers.push(
    () => qa.onModuleDestroy(),
    () => live.onModuleDestroy(),
    () => operations.onModuleDestroy(),
  );
  return {
    qa,
    live,
    repository,
    stage,
    transport,
    delivery,
    host,
    guest,
    snapshots,
    availability,
    broadcast,
    readState: () => state,
  };
}

it('publishes only after mutation, strips caller votes from events, and supplies server bounds/time', async () => {
  const f = await fixture();
  const pending = gate();
  f.repository.submit.mockImplementationOnce(async () => {
    await pending.promise;
    return { ok: true, value: board };
  });
  const before = structuredClone(f.snapshots.at(-1));
  const calls = f.stage.apply.mock.calls.length;
  const running = f.qa.submit(f.host, request, f.delivery);
  await vi.waitFor(() => expect(f.repository.submit).toHaveBeenCalledOnce());
  expect(f.delivery.state).not.toHaveBeenCalled();
  expect(f.repository.submit).toHaveBeenCalledWith(
    'sf_test:room:room',
    { participantId: 'host', socketId: 'socket-host', generation: 1 },
    request,
    {
      boardMax: 100,
      ttlSeconds: 86_400,
      submitParticipantLimit: 5,
      submitRoomLimit: 30,
      voteParticipantLimit: 20,
      voteRoomLimit: 100,
      rateWindowMs: 10_000,
      userRateMaxFields: 1_000,
    },
    1000,
  );
  pending.release();
  expect(await running).toEqual({ ok: true, ...board });
  expect(f.delivery.state).toHaveBeenCalledExactlyOnceWith('room', publicBoard);
  expect(f.stage.apply).toHaveBeenCalledTimes(calls);
  expect(f.snapshots.at(-1)).toEqual(before);
  expect(await f.qa.vote(f.guest, '1', f.delivery)).toEqual({ ok: true, ...board });
  expect(f.repository.vote).toHaveBeenCalledWith(
    'sf_test:room:room',
    { participantId: 'guest', socketId: 'socket-guest', generation: 1 },
    '1',
    expect.any(Object),
    1000,
  );
  expect(await f.qa.state(f.guest)).toEqual({ ok: true, ...board });
  expect(f.delivery.state).toHaveBeenCalledTimes(2);
  expect(f.broadcast.start).not.toHaveBeenCalled();
  expect(f.broadcast.stopRoom).not.toHaveBeenCalled();
});

it.each(moderationMethods)(
  'publishes %s only after the host script commits and retains caller-only votes',
  async (method) => {
    const f = await fixture();
    const pending = gate();
    const value = { ...board, featured: { questionId: '1', text: 'Hello', authorName: 'host' } };
    const before = structuredClone(f.snapshots.at(-1));
    const gateSpy = vi.spyOn(f.live, 'authorizeQa');
    f.repository[method].mockImplementationOnce(async () => {
      await pending.promise;
      return { ok: true, value };
    });
    const running = moderate(f.qa, method, f.host, f.delivery);
    await vi.waitFor(() => expect(f.repository[method]).toHaveBeenCalledOnce());
    expect(f.delivery.state).not.toHaveBeenCalled();
    expect(gateSpy).toHaveBeenCalledWith(f.host, f.host.room, true);
    const expectedArgs: unknown[] = [
      'sf_test:room:room',
      { participantId: 'host', socketId: 'socket-host', generation: 1 },
    ];
    if (method === 'setSubmissions') expectedArgs.push(false);
    else if (method !== 'clearFeature') expectedArgs.push('1');
    expect(f.repository[method]).toHaveBeenCalledWith(...expectedArgs, 86_400);
    pending.release();
    expect(await running).toEqual({ ok: true, ...value });
    expect(f.delivery.state).toHaveBeenCalledExactlyOnceWith('room', {
      ...publicBoard,
      featured: value.featured,
    });
    expect(f.snapshots.at(-1)).toEqual(before);
    expect(f.broadcast.start).not.toHaveBeenCalled();
    expect(f.broadcast.stopRoom).not.toHaveBeenCalled();
    expect(f.stage.tryBeginBroadcast).not.toHaveBeenCalled();
  },
);

it.each(moderationMethods)(
  'rejects non-host %s for speakers, attendees, waiters and demo peers',
  async (method) => {
    const f = await fixture();
    const participant = f.readState().participants.find((p) => p.participantId === 'guest')!;
    for (const role of ['SPEAKER', 'ATTENDEE', 'WAITING'] as const) {
      participant.role = role;
      expect(await moderate(f.qa, method, f.guest, f.delivery)).toMatchObject({
        error: 'not_host',
        message: 'Only the host can do that.',
      });
    }
    participant.role = 'SPEAKER';
    participant.isSyntheticBot = true;
    expect(await moderate(f.qa, method, f.guest, f.delivery)).toMatchObject({ error: 'not_host' });
    expect(f.repository[method]).not.toHaveBeenCalled();
    expect(f.delivery.state).not.toHaveBeenCalled();
    expect(f.broadcast.start).not.toHaveBeenCalled();
  },
);

it.each(moderationMethods)(
  'isolates %s repository errors, throws and stale/ended bindings',
  async (method) => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    const f = await fixture();
    const before = structuredClone(f.snapshots.at(-1));
    for (const error of ['qa_missing', 'not_host', 'stale_transport'] as const) {
      f.repository[method].mockResolvedValueOnce({ ok: false, error });
      expect(await moderate(f.qa, method, f.host, f.delivery)).toMatchObject({ error });
    }
    f.repository[method].mockRejectedValueOnce(new Error('Q&A Redis unavailable'));
    expect(await moderate(f.qa, method, f.host, f.delivery)).toMatchObject({ error: 'qa_busy' });
    expect(await moderate(f.qa, method, { ...f.host, generation: 2 }, f.delivery)).toMatchObject({
      error: 'stale_transport',
    });
    expect(await moderate(f.qa, method, { ...f.host, connected: false }, f.delivery)).toMatchObject(
      { error: 'stale_transport' },
    );
    expect(f.repository[method]).toHaveBeenCalledTimes(4);
    expect(f.delivery.state).not.toHaveBeenCalled();
    expect(f.snapshots.at(-1)).toEqual(before);
    expect(f.broadcast.stopRoom).not.toHaveBeenCalled();
    f.host.room!.status = 'ENDED';
    expect(await moderate(f.qa, method, f.host, f.delivery)).toMatchObject({ error: 'room_ended' });
    expect(f.repository[method]).toHaveBeenCalledTimes(4);
  },
);

it('features a meeting question without reserving or starting a broadcast, and retains meeting rejection', async () => {
  const f = await fixture('LIVE', 'MEETING');
  const before = structuredClone(f.snapshots.at(-1));
  expect(before?.broadcast).toBeNull();
  const start = vi.spyOn(f.live, 'startBroadcast');
  const value = { ...board, featured: { questionId: '1', text: 'Hello', authorName: 'host' } };
  f.repository.feature.mockResolvedValueOnce({ ok: true, value });
  expect(await f.qa.feature(f.host, '1', f.delivery)).toEqual({ ok: true, ...value });
  expect(start).not.toHaveBeenCalled();
  expect(f.stage.tryBeginBroadcast).not.toHaveBeenCalled();
  expect(f.broadcast.start).not.toHaveBeenCalled();
  expect(f.snapshots.at(-1)).toEqual(before);
  expect(await f.live.startBroadcast(f.host, f.transport)).toMatchObject({
    error: 'broadcast_not_available',
  });
  expect(f.stage.tryBeginBroadcast).not.toHaveBeenCalled();
  expect(f.broadcast.start).not.toHaveBeenCalled();
});

it('allows host moderation before scheduled Start using the membership role', async () => {
  const f = await fixture('SCHEDULED');
  for (const method of moderationMethods)
    expect((await moderate(f.qa, method, f.host, f.delivery)).ok).toBe(true);
  expect(f.delivery.state).toHaveBeenCalledTimes(4);
});

it.each([
  'qa_closed',
  'qa_full',
  'qa_rate_limited',
  'qa_vote_rate_limited',
  'qa_not_allowed',
  'qa_missing',
  'qa_busy',
  'stale_transport',
] as const)('returns repository %s without stage or broadcast effects', async (error) => {
  const f = await fixture();
  const before = structuredClone(f.snapshots.at(-1));
  f.repository.submit.mockResolvedValueOnce({ ok: false, error });
  expect(await f.qa.submit(f.host, request, f.delivery)).toMatchObject({ ok: false, error });
  expect(f.delivery.state).not.toHaveBeenCalled();
  expect(f.snapshots.at(-1)).toEqual(before);
  expect(f.broadcast.stopRoom).not.toHaveBeenCalled();
  expect(await f.live.leave(f.guest, f.transport)).toEqual({ ok: true });
});

it('isolates repository throws and unavailable Redis from stage, broadcast, and leave', async () => {
  vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
  const f = await fixture();
  const before = structuredClone(f.snapshots.at(-1));
  expect(before?.broadcast).toMatchObject({ id: 'broadcast', status: 'LIVE' });
  const calls = f.stage.apply.mock.calls.length;
  f.availability.ready = false;
  expect(await f.qa.submit(f.host, request, f.delivery)).toMatchObject({ error: 'qa_busy' });
  expect(f.repository.submit).not.toHaveBeenCalled();
  f.availability.ready = true;
  for (const method of ['submit', 'vote', 'state'] as const)
    f.repository[method].mockRejectedValueOnce(new Error('Q&A Redis unavailable'));
  expect(await f.qa.submit(f.host, request, f.delivery)).toMatchObject({ error: 'qa_busy' });
  expect(await f.qa.vote(f.guest, '1', f.delivery)).toMatchObject({ error: 'qa_busy' });
  expect(await f.qa.state(f.host)).toMatchObject({ error: 'qa_busy' });
  expect(f.delivery.state).not.toHaveBeenCalled();
  expect(f.stage.apply).toHaveBeenCalledTimes(calls);
  expect(f.snapshots.at(-1)).toEqual(before);
  expect(f.broadcast.stopRoom).not.toHaveBeenCalled();
  expect(await f.live.leave(f.guest, f.transport)).toEqual({ ok: true });
  expect(f.broadcast.stopRoom).not.toHaveBeenCalled();
});

it('bounds the queue at 32 waiting and completes leave while Q&A is blocked', async () => {
  const f = await fixture();
  const pending = gate();
  f.repository.submit.mockImplementationOnce(async () => {
    await pending.promise;
    return { ok: true, value: board };
  });
  const before = structuredClone(f.snapshots.at(-1));
  const running = f.qa.submit(f.host, request, f.delivery);
  await vi.waitFor(() => expect(f.repository.submit).toHaveBeenCalledOnce());
  const waiting = Array.from({ length: QA_MAX_QUEUED_OPERATIONS }, () =>
    f.qa.submit(f.host, request, f.delivery),
  );
  try {
    expect(await f.qa.submit(f.host, request, f.delivery)).toMatchObject({
      error: 'qa_busy',
      message: 'Questions are busy. Try again shortly.',
    });
    expect(await f.qa.vote(f.host, '1', f.delivery)).toMatchObject({ error: 'qa_busy' });
    expect(await f.qa.state(f.host)).toMatchObject({ error: 'qa_busy' });
    for (const method of moderationMethods)
      expect(await moderate(f.qa, method, f.host, f.delivery)).toMatchObject({ error: 'qa_busy' });
    expect(f.snapshots.at(-1)).toEqual(before);
    expect(await f.live.leave(f.guest, f.transport)).toEqual({ ok: true });
    expect(f.broadcast.stopRoom).not.toHaveBeenCalled();
    expect(f.repository.submit).toHaveBeenCalledOnce();
  } finally {
    pending.release();
  }
  expect((await running).ok).toBe(true);
  expect((await Promise.all(waiting)).every((r) => r.ok)).toBe(true);
});

it('rejects unbound, disconnected, stale and suspended memberships using the independent Q&A gate', async () => {
  const f = await fixture();
  const original = { ...f.guest };
  const chatGate = vi.spyOn(f.live, 'authorizeChat');
  expect(await f.qa.state({ ...original, room: undefined })).toMatchObject({ error: 'not_joined' });
  for (const member of [
    { ...original, id: 'old' },
    { ...original, generation: 2 },
    { ...original, connected: false },
    { ...original, participantId: 'missing' },
    { ...original, room: { ...original.room!, roomId: 'wrong-room' } },
  ])
    expect(await f.qa.state(member)).toMatchObject({ error: 'stale_transport' });
  await f.live.disconnect(f.guest, f.transport);
  expect(await f.qa.state(original)).toMatchObject({ error: 'stale_transport' });
  expect(f.repository.state).not.toHaveBeenCalled();
  expect(chatGate).not.toHaveBeenCalled();
});

it('allows the pre-start host, rejects a waiter and a synthetic speaker, and refuses ended rooms', async () => {
  const f = await fixture('SCHEDULED');
  expect((await f.qa.state(f.host)).ok).toBe(true);
  expect(await f.qa.state(f.guest)).toMatchObject({ error: 'qa_not_allowed' });
  const g = await fixture();
  const row = g.readState().participants.find((p) => p.participantId === 'guest')!;
  row.role = 'SPEAKER';
  row.isSyntheticBot = true;
  expect(await g.qa.submit(g.guest, request, g.delivery)).toMatchObject({
    error: 'qa_not_allowed',
  });
  g.host.room!.status = 'ENDED';
  expect(await g.qa.state(g.host)).toMatchObject({ error: 'room_ended' });
  expect(g.repository.submit).not.toHaveBeenCalled();
});

it('does not execute queued work after the caller changes rooms or generation', async () => {
  const f = await fixture();
  const pending = gate();
  f.repository.submit.mockImplementationOnce(async () => {
    await pending.promise;
    return { ok: true, value: board };
  });
  const running = f.qa.submit(f.host, request, f.delivery);
  await vi.waitFor(() => expect(f.repository.submit).toHaveBeenCalledOnce());
  const queued = f.qa.state(f.guest);
  f.guest.room = { ...f.guest.room!, roomId: 'elsewhere' };
  pending.release();
  await running;
  expect(await queued).toMatchObject({ error: 'stale_transport' });
  expect(f.repository.state).not.toHaveBeenCalled();
});
