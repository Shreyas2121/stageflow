import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { expect, it, vi } from 'vitest';
import {
  applyStageCommand,
  CHAT_MAX_QUEUED_OPERATIONS,
  type ChatMessage,
  type LiveState,
  type RoomSnapshot,
} from '@stageflow/shared';
import { ChatService, type ChatTransport } from './chat.service';
import type { ChatRepository } from './chat.repository';
import { LiveService, type LiveSession, type LiveTransport } from '../live/live.service';
import type { LiveRepository } from '../live/live.repository';
import { SerializedOperations } from '../live/serialized-operations';

const message: ChatMessage = {
  sequence: 1,
  participantId: 'host',
  displayName: 'Host',
  role: 'HOST',
  text: 'hello',
  sentAt: 1000,
};
const history = {
  paused: false,
  oldestSequence: 1,
  latestSequence: 1,
  retentionGap: false,
  messages: [message],
};
const request = () => ({ requestId: randomUUID(), text: 'hello' });
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function fixture() {
  let state: LiveState = {
    roomId: 'room',
    hostId: 'host',
    mode: 'WEBINAR',
    status: 'LIVE',
    participants: [],
    stageParticipantIds: [],
    waitingParticipantIds: [],
    hands: [],
    resumeDigests: {},
    deadlines: {},
  };
  const stage = {
    apply: vi.fn<LiveRepository['apply']>(async (_prefix, _room, command) => {
      const result = applyStageCommand(state, command);
      if (result.ok) state = result.state;
      return { ...result, revision: 1 };
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
    accept: vi.fn<ChatRepository['accept']>(async () => ({ ok: true, value: message })),
    history: vi.fn<ChatRepository['history']>(async () => ({ ok: true, value: history })),
    setPaused: vi.fn<ChatRepository['setPaused']>(async (_prefix, _binding, paused) => ({
      ok: true,
      value: { paused },
    })),
    delete: vi.fn<ChatRepository['delete']>(async () => {}),
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
  const live = new LiveService(
    {
      getById: async () =>
        ({ id: 'room', hostId: 'host', mode: 'WEBINAR', status: 'LIVE' }) as never,
      startScheduled: vi.fn(async () => true),
      cancelScheduled: vi.fn(async () => true),
      end: vi.fn(async () => {}),
    },
    stage,
    new SerializedOperations(),
    availability,
    'sf_test',
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
  const chat = new ChatService(repository, live, 'sf_test', () => 1000);
  const delivery: ChatTransport = { message: vi.fn(), paused: vi.fn() };
  return {
    chat,
    live,
    repository,
    stage,
    transport,
    delivery,
    host,
    guest,
    snapshots,
    availability,
  };
}

it('publishes only after acceptance, returns the same message, and passes shared bounds and server time', async () => {
  const f = await fixture();
  const pending = gate();
  f.repository.accept.mockImplementationOnce(async () => {
    await pending.promise;
    return { ok: true, value: message };
  });
  const before = f.stage.apply.mock.calls.length;
  const snapshot = f.snapshots.at(-1);
  const send = request();
  const result = f.chat.send(f.host, send, f.delivery);
  await vi.waitFor(() => expect(f.repository.accept).toHaveBeenCalledOnce());
  expect(f.delivery.message).not.toHaveBeenCalled();
  expect(f.repository.accept).toHaveBeenCalledWith(
    'sf_test:room:room',
    { participantId: 'host', socketId: 'socket-host', generation: 1 },
    send,
    {
      retention: 500,
      dedupCapacity: 500,
      ttlSeconds: 86_400,
      participantRateLimit: 10,
      roomRateLimit: 100,
      rateWindowMs: 10_000,
      userRateMaxFields: 1_000,
    },
    1000,
  );
  pending.release();
  expect(await result).toEqual({ ok: true, message });
  expect(f.delivery.message).toHaveBeenCalledExactlyOnceWith('room', message);
  expect(f.stage.apply).toHaveBeenCalledTimes(before);
  expect(f.snapshots.at(-1)).toBe(snapshot);
});

it('returns history only to its caller and publishes pause only after the host script commits', async () => {
  const f = await fixture();
  expect(await f.chat.history(f.guest, { limit: 50 })).toEqual({ ok: true, ...history });
  expect(f.delivery.message).not.toHaveBeenCalled();
  const pending = gate();
  f.repository.setPaused.mockImplementationOnce(async () => {
    await pending.promise;
    return { ok: true, value: { paused: true } };
  });
  const paused = f.chat.setPaused(f.host, true, f.delivery);
  await vi.waitFor(() => expect(f.repository.setPaused).toHaveBeenCalledOnce());
  expect(f.delivery.paused).not.toHaveBeenCalled();
  pending.release();
  expect(await paused).toEqual({ ok: true, paused: true });
  expect(f.delivery.paused).toHaveBeenCalledExactlyOnceWith('room', { paused: true });
  f.repository.setPaused.mockResolvedValueOnce({ ok: false, error: 'not_host' });
  expect(await f.chat.setPaused(f.guest, false, f.delivery)).toMatchObject({ error: 'not_host' });
  expect(f.delivery.paused).toHaveBeenCalledOnce();
});

it.each(['chat_paused', 'chat_rate_limited', 'chat_busy', 'stale_transport'] as const)(
  'honors Redis %s without publishing, changing stage state, or blocking leave',
  async (error) => {
    const f = await fixture();
    const before = f.snapshots.at(-1);
    f.repository.accept.mockResolvedValueOnce({ ok: false, error });
    expect(await f.chat.send(f.host, request(), f.delivery)).toMatchObject({ ok: false, error });
    expect(f.delivery.message).not.toHaveBeenCalled();
    expect(f.snapshots.at(-1)).toBe(before);
    expect(await f.live.leave(f.guest, f.transport)).toEqual({ ok: true });
  },
);

it('admits at most 32 waiting chat operations and completes room leave while chat is blocked', async () => {
  const f = await fixture();
  const pending = gate();
  f.repository.accept.mockImplementationOnce(async () => {
    await pending.promise;
    return { ok: true, value: message };
  });
  const running = f.chat.send(f.host, request(), f.delivery);
  await vi.waitFor(() => expect(f.repository.accept).toHaveBeenCalledOnce());
  const waiting = Array.from({ length: CHAT_MAX_QUEUED_OPERATIONS }, () =>
    f.chat.send(f.host, request(), f.delivery),
  );
  try {
    expect(await f.chat.send(f.host, request(), f.delivery)).toMatchObject({
      error: 'chat_busy',
      message: 'Chat is busy. Try again shortly.',
    });
    expect(await f.chat.history(f.host, { limit: 50 })).toMatchObject({ error: 'chat_busy' });
    expect(await f.chat.setPaused(f.host, true, f.delivery)).toMatchObject({ error: 'chat_busy' });
    expect(await f.live.leave(f.guest, f.transport)).toEqual({ ok: true });
    expect(f.repository.accept).toHaveBeenCalledOnce();
  } finally {
    pending.release();
  }
  expect((await running).ok).toBe(true);
  expect((await Promise.all(waiting)).every((result) => result.ok)).toBe(true);
  await f.chat.onModuleDestroy();
});

it('rejects unbound, disconnected, stale, suspended and changed-room callers using live membership authority', async () => {
  const f = await fixture();
  const original = { ...f.guest };
  expect(await f.chat.send({ ...original, room: undefined }, request(), f.delivery)).toMatchObject({
    error: 'not_joined',
  });
  for (const member of [
    { ...original, id: 'replaced-socket' },
    { ...original, generation: 2 },
    { ...original, connected: false },
    { ...original, participantId: 'missing' },
    { ...original, room: { ...original.room!, roomId: 'wrong-room' } },
  ])
    expect(await f.chat.send(member, request(), f.delivery)).toMatchObject({
      error: 'stale_transport',
    });
  expect(f.repository.accept).not.toHaveBeenCalled();
  // Suspend through the real stage reducer and keep an old socket's binding.
  await f.live.disconnect(f.guest, f.transport);
  expect(await f.chat.history(original, { limit: 50 })).toMatchObject({ error: 'stale_transport' });
  expect(await f.chat.setPaused(original, false, f.delivery)).toMatchObject({
    error: 'stale_transport',
  });
  f.live.onModuleDestroy();
});

it('does not apply queued work to a new room association', async () => {
  const f = await fixture();
  const pending = gate();
  f.repository.accept.mockImplementationOnce(async () => {
    await pending.promise;
    return { ok: true, value: message };
  });
  const first = f.chat.send(f.host, request(), f.delivery);
  await vi.waitFor(() => expect(f.repository.accept).toHaveBeenCalledOnce());
  const queued = f.chat.send(f.guest, request(), f.delivery);
  f.guest.room = { ...f.guest.room!, roomId: 'another-room' };
  pending.release();
  await first;
  expect(await queued).toMatchObject({ error: 'stale_transport' });
  expect(f.repository.accept).toHaveBeenCalledOnce();
});

it('reports unavailable Redis and publication failures as chat_busy without a room-reset sentence', async () => {
  const logger = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
  try {
    const f = await fixture();
    f.availability.ready = false;
    expect(await f.chat.send(f.host, request(), f.delivery)).toMatchObject({ error: 'chat_busy' });
    expect(f.repository.accept).not.toHaveBeenCalled();
    f.availability.ready = true;
    f.repository.accept.mockRejectedValueOnce(new Error('Redis unavailable'));
    expect(await f.chat.send(f.host, request(), f.delivery)).toMatchObject({ error: 'chat_busy' });
    vi.mocked(f.delivery.message).mockImplementationOnce(() => {
      throw new Error('delivery unavailable');
    });
    const retry = request();
    const failed = await f.chat.send(f.host, retry, f.delivery);
    expect(failed).toMatchObject({
      error: 'chat_busy',
      message: 'Chat is busy. Try again shortly.',
    });
    expect(await f.chat.send(f.host, retry, f.delivery)).toEqual({ ok: true, message });
    expect(await f.live.leave(f.guest, f.transport)).toEqual({ ok: true });
  } finally {
    logger.mockRestore();
  }
});
