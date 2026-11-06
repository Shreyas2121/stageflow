import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { applyStageCommand, type LiveState, type RoomSnapshot } from '@stageflow/shared';
import {
  LiveService,
  type BroadcastControl,
  type LiveSession,
  type LiveTransport,
  type LiveClock,
} from './live.service';
import { SerializedOperations } from './serialized-operations';
import type { LiveRepository } from './live.repository';
import type { RoomsService } from '../rooms/rooms.service';
import type { ChatRepository } from '../chat/chat.repository';
import type { QaRepository } from '../qa/qa.repository';
function fixture(
  mode: LiveState['mode'] = 'MEETING',
  availability: { isReady(): boolean } = { isReady: () => true },
  namespace = 'sf',
  operations = new SerializedOperations(),
  broadcasts?: BroadcastControl,
  clock?: LiveClock,
  status: LiveState['status'] = 'LIVE',
  requireAdmission?: boolean,
) {
  let state: LiveState = {
    roomId: 'room',
    hostId: 'host',
    mode,
    status,
    ...(requireAdmission !== undefined ? { requireAdmission } : {}),
    participants: [],
    stageParticipantIds: [],
    waitingParticipantIds: [],
    hands: [],
    resumeDigests: {},
    deadlines: {},
  };
  let revision = 0;
  const events: string[] = [];
  const snapshots: RoomSnapshot[] = [];
  const sessions = new Map<string, LiveSession>();
  let catalogStatus: LiveState['status'] = status;
  const client = (id: string, userId = id): LiveSession => {
    const session = { id, user: { id: userId, displayName: id }, connected: true, room: undefined };
    sessions.set(id, session);
    return session;
  };
  const rooms: Pick<RoomsService, 'getById' | 'end' | 'startScheduled' | 'cancelScheduled'> = {
    getById: vi.fn(
      async () =>
        ({ id: 'room', hostId: 'host', mode, status: catalogStatus, requireAdmission }) as Awaited<
          ReturnType<RoomsService['getById']>
        >,
    ),
    startScheduled: vi.fn(async () => {
      events.push('database:start');
      if (catalogStatus !== 'SCHEDULED') return false;
      catalogStatus = 'LIVE';
      return true;
    }),
    cancelScheduled: vi.fn(async () => {
      events.push('database:cancel');
      if (catalogStatus !== 'SCHEDULED') return false;
      catalogStatus = 'ENDED';
      return true;
    }),
    end: vi.fn(async () => {
      events.push('database:end');
      catalogStatus = 'ENDED';
    }),
  };
  const live: Pick<
    LiveRepository,
    | 'apply'
    | 'readStage'
    | 'readConnectedStage'
    | 'readSocket'
    | 'readParticipant'
    | 'deleteRoom'
    | 'refreshSnapshot'
  > = {
    refreshSnapshot: vi.fn<LiveRepository['refreshSnapshot']>(async () => ({
      ok: true,
      state,
      revision: ++revision,
      changed: true,
      roomEnded: false,
    })),
    apply: vi.fn(async (_prefix, _room, command) => {
      events.push('apply:' + command.type);
      const result = applyStageCommand(state, command);
      if (result.ok) {
        state = result.state;
        if (result.changed) revision++;
      }
      return { ...result, revision };
    }),
    readParticipant: vi.fn(
      async (_prefix, id) => state.participants.find((p) => p.participantId === id) ?? null,
    ),
    readStage: vi.fn(async () => state.stageParticipantIds),
    readConnectedStage: vi.fn(async () =>
      state.stageParticipantIds.filter((id) =>
        state.participants.some((p) => p.participantId === id && p.presence === 'connected'),
      ),
    ),
    readSocket: vi.fn(
      async (_prefix, id) =>
        state.participants.find((p) => p.participantId === id && p.presence === 'connected')
          ?.socketId ?? null,
    ),
    deleteRoom: vi.fn(async () => {
      events.push('redis:delete');
    }),
  };
  const transport: LiveTransport = {
    forceMute: vi.fn((id) => {
      events.push('force-mute:' + id);
    }),
    join: vi.fn(async (id) => {
      expect(sessions.get(id)?.room).toBeDefined();
      events.push('join:' + id);
    }),
    leave: vi.fn(async (id) => {
      events.push('leave:' + id);
    }),
    publish: vi.fn((snapshot) => {
      events.push('publish');
      snapshots.push(snapshot);
    }),
    peer: (id) => {
      const peer = sessions.get(id);
      return peer ? { connected: peer.connected, roomId: peer.room?.roomId } : undefined;
    },
    end: vi.fn(() => {
      events.push('transport:end');
      for (const peer of sessions.values()) peer.room = undefined;
    }),
  };
  const chat = { delete: vi.fn<ChatRepository['delete']>(async () => {}) };
  const qa = { delete: vi.fn<QaRepository['delete']>(async () => {}) };
  const service = new LiveService(
    rooms,
    live,
    operations,
    availability,
    namespace,
    broadcasts,
    clock,
    chat,
    qa,
  );
  const join = (peer: LiveSession, isSyntheticBot = false) =>
    service.join(
      peer,
      { roomId: 'room', isAudioMuted: false, isVideoOff: false, isSyntheticBot },
      transport,
      peer.id,
      isSyntheticBot
        ? undefined
        : createHash('sha256').update(`credential-${peer.user.id}`).digest('hex'),
    );
  return {
    service,
    rooms,
    live,
    chat,
    qa,
    transport,
    client,
    join,
    events,
    snapshots,
    readState: () => state,
  };
}
function silenceErrors() {
  return vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
}

it('deletes Q&A immediately after chat and retries failed Q&A cleanup before ending transport', async () => {
  const logger = silenceErrors();
  const f = fixture();
  try {
    const host = f.client('host'),
      guest = f.client('guest');
    await f.join(host);
    await f.join(guest);
    f.chat.delete.mockImplementation(async () => {
      f.events.push('chat:delete');
    });
    f.qa.delete.mockImplementation(async () => {
      f.events.push('qa:delete');
    });
    f.qa.delete.mockRejectedValueOnce(new Error('Q&A delete unavailable'));
    f.events.length = 0;
    expect(await f.service.leave(host, f.transport)).toMatchObject({ error: 'server_error' });
    expect(f.events).toEqual(['apply:leave', 'database:end', 'redis:delete', 'chat:delete']);
    expect(f.qa.delete).toHaveBeenCalledExactlyOnceWith('sf:room:room');
    expect(f.transport.end).not.toHaveBeenCalled();
    expect(await f.service.authorizeQa(guest, guest.room!)).toMatchObject({ error: 'room_ended' });
    expect(await f.service.leave(host, f.transport)).toEqual({ ok: true });
    expect(f.events.slice(-5)).toEqual([
      'database:end',
      'redis:delete',
      'chat:delete',
      'qa:delete',
      'transport:end',
    ]);
    expect(f.qa.delete).toHaveBeenCalledTimes(2);
    expect(host.room).toBeUndefined();
    expect(guest.room).toBeUndefined();
  } finally {
    logger.mockRestore();
  }
});

it.each(['host', 'waiter'])(
  'removes a scheduled %s on disconnect without scheduling grace',
  async (id) => {
    const time = controlledClock();
    const f = fixture(
      'MEETING',
      undefined,
      undefined,
      undefined,
      undefined,
      time.clock,
      'SCHEDULED',
    );
    try {
      const first = f.client('first');
      const departing = f.client(id);
      await f.join(first);
      await f.join(departing);
      expect(f.snapshots.at(-1)).toMatchObject({
        status: 'SCHEDULED',
        stageParticipantIds: [],
        waitingParticipantIds: id === 'host' ? ['first'] : ['first', 'waiter'],
      });
      expect(f.live.apply).toHaveBeenLastCalledWith(
        expect.any(String),
        expect.anything(),
        expect.not.objectContaining({ resumeDigest: expect.anything() }),
      );
      Object.assign(departing, { connected: false });
      expect(await f.service.disconnect(departing, f.transport)).toEqual({ ok: true });
      expect(departing.room).toBeUndefined();
      expect(f.readState().participants.map((p) => p.participantId)).toEqual(['first']);
      expect(f.readState().deadlines).toEqual({});
      expect(f.readState().resumeDigests).toEqual({});
      expect(time.clock.schedule).not.toHaveBeenCalled();
      expect(f.rooms.end).not.toHaveBeenCalled();
      expect(f.live.deleteRoom).not.toHaveBeenCalled();
      expect(f.events).toContain('apply:leave');
      expect(f.events).not.toContain('apply:suspend');
      time.set(2000);
      expect(await f.join(f.client('rejoined', id))).toEqual({ ok: true });
      expect(f.readState().status).toBe('SCHEDULED');
      expect(f.snapshots.at(-1)?.waitingParticipantIds).toEqual(
        id === 'host' ? ['first'] : ['first', 'rejoined'],
      );
    } finally {
      f.service.onModuleDestroy();
    }
  },
);

function controlledClock() {
  let now = 1000;
  const callbacks: (() => void)[] = [];
  const clock: LiveClock = {
    now: () => now,
    schedule: vi.fn((callback) => {
      callbacks.push(callback);
      return vi.fn();
    }),
  };
  return {
    clock,
    callbacks,
    set: (value: number) => {
      now = value;
    },
  };
}

it.each([false, true])(
  'retries scheduled disconnect cleanup without grace when leave committed=%s',
  async (committed) => {
    const time = controlledClock();
    const f = fixture(
      'MEETING',
      undefined,
      undefined,
      undefined,
      undefined,
      time.clock,
      'SCHEDULED',
    );
    const errors = silenceErrors();
    try {
      const peer = f.client('waiter');
      await f.join(peer);
      const apply = vi.mocked(f.live.apply);
      const original = apply.getMockImplementation()!;
      apply.mockImplementationOnce(async (...args) => {
        if (committed) await original(...args);
        throw new Error('Lost scheduled leave reply');
      });
      expect(await f.service.disconnect(peer, f.transport)).toMatchObject({
        error: 'server_error',
      });
      expect(f.readState().deadlines).toEqual({});
      expect(f.readState().resumeDigests).toEqual({});
      expect(time.clock.schedule).toHaveBeenCalledOnce();
      await f.service.sweep();
      expect(peer.room).toBeUndefined();
      expect(f.readState().waitingParticipantIds).toEqual([]);
      expect(f.readState().participants).toEqual([]);
      expect(f.snapshots.at(-1)).toMatchObject({ status: 'SCHEDULED', waitingParticipantIds: [] });
      expect(f.events).not.toContain('apply:suspend');
      expect(f.rooms.end).not.toHaveBeenCalled();
    } finally {
      f.service.onModuleDestroy();
      errors.mockRestore();
    }
  },
);
const resumeRequest = (id: string) => ({
  roomId: 'room',
  participantId: id,
  resumeCredential: `credential-${id}`,
});

it('suspends on the cleanup reserve, clears the old binding, and resumes once without exposing a verifier', async () => {
  const time = controlledClock();
  const f = fixture('MEETING', undefined, undefined, undefined, undefined, time.clock);
  await f.join(f.client('host'));
  const guest = f.client('guest');
  await f.join(guest);
  const stale = { ...guest };
  expect(await f.service.disconnect(guest, f.transport)).toEqual({ ok: true });
  expect(guest.room).toBeUndefined();
  expect(guest.participantId).toBeUndefined();
  expect(guest.generation).toBeUndefined();
  expect(f.snapshots.at(-1)!.participants.find((p) => p.participantId === 'guest')).toMatchObject({
    presence: 'suspended',
    socketId: null,
    isAudioMuted: true,
    isVideoOff: true,
  });
  expect(f.snapshots.at(-1)!.stageParticipantIds).toHaveLength(2);
  expect(await f.join(f.client('another-guest', 'guest'))).toMatchObject({
    error: 'already_joined',
  });
  const attempts = [f.client('new-one', 'guest'), f.client('new-two', 'guest')];
  const results = await Promise.all(
    attempts.map((client) => f.service.resume(client, resumeRequest('guest'), f.transport)),
  );
  expect(results.filter((result) => result.ok)).toHaveLength(1);
  expect(results.find((result) => !result.ok)).toMatchObject({ error: 'resume_lost' });
  const ack = results.find((result) => result.ok)!;
  expect(ack).toMatchObject({ participantId: 'guest', connectionGeneration: 2 });
  expect(JSON.stringify(f.snapshots)).not.toContain('resumeDigests');
  expect(JSON.stringify(f.snapshots)).not.toContain('credential-guest');
  expect(
    await f.service.update(
      stale,
      { type: 'patchMedia', participantId: 'guest', patch: { isAudioMuted: false } },
      f.transport,
    ),
  ).toMatchObject({ error: 'stale_transport' });
  expect(await f.service.relay(stale, 'host', f.transport, vi.fn())).toMatchObject({
    error: 'stale_transport',
  });
  expect(await f.service.leave(stale, f.transport)).toMatchObject({ error: 'stale_transport' });
  time.set(99999);
  await f.service.sweep();
  expect(f.snapshots.at(-1)!.participants.find((p) => p.participantId === 'guest')?.presence).toBe(
    'connected',
  );
  f.service.onModuleDestroy();
});

it('expires with an injected clock and rejects join and resume if expiry fails', async () => {
  const logger = silenceErrors();
  const time = controlledClock();
  const f = fixture('MEETING', undefined, undefined, undefined, undefined, time.clock);
  try {
    await f.join(f.client('host'));
    const guest = f.client('guest');
    await f.join(guest);
    await f.service.disconnect(guest, f.transport);
    time.set(21000);
    vi.mocked(f.live.apply).mockRejectedValueOnce(new Error('expiry unavailable'));
    expect(await f.join(f.client('new', 'guest'))).toMatchObject({ error: 'server_error' });
    expect(f.live.apply).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), {
      type: 'expire',
      now: 21000,
    });
    vi.mocked(f.live.apply).mockRejectedValueOnce(new Error('expiry unavailable'));
    expect(
      await f.service.resume(f.client('resume', 'guest'), resumeRequest('guest'), f.transport),
    ).toMatchObject({ error: 'server_error' });
    await f.service.sweep();
    expect(f.snapshots.at(-1)!.participants.map((p) => p.participantId)).toEqual(['host']);
    expect(await f.join(f.client('next', 'guest'))).toEqual({ ok: true });
  } finally {
    f.service.onModuleDestroy();
    logger.mockRestore();
  }
});

it('retries a failed suspension on the sweep and never extends a committed deadline', async () => {
  const logger = silenceErrors();
  const time = controlledClock();
  const f = fixture('MEETING', undefined, undefined, undefined, undefined, time.clock);
  try {
    await f.join(f.client('host'));
    const guest = f.client('guest');
    await f.join(guest);
    vi.mocked(f.live.apply).mockRejectedValueOnce(new Error('redis unavailable'));
    expect(await f.service.disconnect(guest, f.transport)).toMatchObject({ error: 'server_error' });
    expect(guest.room).toBeDefined();
    await f.service.sweep();
    expect(guest.room).toBeUndefined();
    const revision = f.snapshots.at(-1)!.revision;
    time.set(20000);
    await f.service.disconnect(guest, f.transport);
    await f.service.sweep();
    expect(f.snapshots.at(-1)!.revision).toBe(revision);
    time.set(21000);
    await f.service.sweep();
    expect(f.snapshots.at(-1)!.participants).toHaveLength(1);
  } finally {
    f.service.onModuleDestroy();
    logger.mockRestore();
  }
});

it('retains a committed suspension snapshot for retry after publication fails', async () => {
  const logger = silenceErrors();
  const time = controlledClock();
  const f = fixture('MEETING', undefined, undefined, undefined, undefined, time.clock);
  try {
    await f.join(f.client('host'));
    const guest = f.client('guest');
    await f.join(guest);
    vi.mocked(f.transport.publish).mockImplementationOnce(() => {
      throw new Error('publish unavailable');
    });
    expect(await f.service.disconnect(guest, f.transport)).toMatchObject({ error: 'server_error' });
    expect(guest.room).toBeUndefined();
    await f.service.sweep();
    expect(
      f.snapshots.at(-1)!.participants.find((p) => p.participantId === 'guest')?.presence,
    ).toBe('suspended');
    expect(f.live.apply).toHaveBeenCalledTimes(4);
    time.set(21000);
    await f.service.sweep();
    expect(f.snapshots.at(-1)!.participants).toHaveLength(1);
  } finally {
    f.service.onModuleDestroy();
    logger.mockRestore();
  }
});

it('adopts a suspension after an ambiguous Redis reply without extending its deadline', async () => {
  const logger = silenceErrors();
  const time = controlledClock();
  const f = fixture('MEETING', undefined, undefined, undefined, undefined, time.clock);
  try {
    await f.join(f.client('host'));
    const guest = f.client('guest');
    await f.join(guest);
    const apply = vi.mocked(f.live.apply).getMockImplementation()!;
    vi.mocked(f.live.apply).mockImplementationOnce(async (...args) => {
      await apply(...args);
      throw new Error('reply lost');
    });
    expect(await f.service.disconnect(guest, f.transport)).toMatchObject({ error: 'server_error' });
    time.set(2000);
    await f.service.sweep();
    expect(guest.room).toBeUndefined();
    expect(
      f.snapshots.at(-1)!.participants.find((p) => p.participantId === 'guest')?.presence,
    ).toBe('suspended');
    time.set(21000);
    await f.service.sweep();
    expect(f.snapshots.at(-1)!.participants).toHaveLength(1);
  } finally {
    f.service.onModuleDestroy();
    logger.mockRestore();
  }
});

it('routes stable participant ids to their current transports and leaves by membership id', async () => {
  const f = fixture();
  const host = f.client('host');
  const guest = f.client('guest');
  const request = { roomId: 'room', isAudioMuted: false, isVideoOff: false, isSyntheticBot: false };
  expect(await f.service.join(host, request, f.transport, 'member-host')).toEqual({ ok: true });
  expect(await f.service.join(guest, request, f.transport, 'member-guest')).toEqual({ ok: true });
  expect(host.participantId).toBe('member-host');
  expect(f.snapshots.at(-1)?.stageParticipantIds).toEqual(['member-guest', 'member-host']);
  const send = vi.fn();
  expect(await f.service.relay(host, 'member-guest', f.transport, send)).toEqual({ ok: true });
  expect(send).toHaveBeenCalledExactlyOnceWith('guest');
  expect(await f.service.relay(host, 'missing', f.transport, send)).toMatchObject({
    error: 'not_connected',
  });
  await f.service.update(
    host,
    {
      type: 'setHostLock',
      actorParticipantId: 'member-host',
      targetParticipantId: 'member-guest',
      kind: 'audio',
      locked: true,
    },
    f.transport,
  );
  expect(f.transport.forceMute).toHaveBeenCalledExactlyOnceWith('guest', {
    kind: 'audio',
    locked: true,
  });
  await f.service.leave(guest, f.transport);
  expect(f.live.apply).toHaveBeenLastCalledWith('sf:room:room', expect.anything(), {
    type: 'leave',
    participantId: 'member-guest',
    transport: { participantId: 'member-guest', socketId: 'guest', generation: 1 },
  });
  expect(guest.participantId).toBeUndefined();
});

function broadcastFixture(mode: LiveState['mode'] = 'WEBINAR', clock?: LiveClock) {
  let active: string | null = null;
  let broadcast: RoomSnapshot['broadcast'] = null;
  let onChildExit: ((action: () => Promise<void>) => void) | undefined;
  const control: BroadcastControl = {
    repository: {
      readBroadcast: vi.fn(async () => active),
      readParticipant: vi.fn(
        async (_prefix, id) =>
          f.snapshots.at(-1)?.participants.find((p) => p.participantId === id) ?? null,
      ),
      refreshSnapshot: (_prefix, room) => f.live.refreshSnapshot(_prefix, room),
      tryBeginBroadcast: vi.fn(async (_prefix, id) => {
        if (active) return false;
        active = id;
        return true;
      }),
      clearBroadcast: vi.fn(async () => {
        active = null;
      }),
    },
    service: {
      failInterrupted: vi.fn(async () => {
        f.events.push('broadcast:interrupted');
        active = null;
        if (broadcast)
          broadcast = { ...broadcast, status: 'FAILED', errorMessage: 'Host connection lost.' };
      }),
      snapshot: vi.fn(async () => broadcast),
      start: vi.fn<BroadcastControl['service']['start']>(async (_room, _host, hooks) => {
        onChildExit = hooks.onExit;
        await hooks.reserve('broadcast-id');
        broadcast = { id: 'broadcast-id', status: 'LIVE', playlistUrl: null, errorMessage: null };
        await hooks.publish();
        return { ok: true };
      }),
      stopRoom: vi.fn(async () => {
        f.events.push('broadcast:stop');
        active = null;
      }),
    },
  };
  const f = fixture(mode, undefined, undefined, undefined, control, clock);
  return { ...f, control, onChildExit: () => onChildExit };
}

it('fails the host broadcast, removes demos, and keeps the catalog live until the scheduled host expiry', async () => {
  const time = controlledClock();
  const f = broadcastFixture('WEBINAR', time.clock);
  const host = f.client('host');
  await f.join(host);
  await f.join(f.client('bot'), true);
  await f.join(f.client('human'));
  await f.service.startBroadcast(host, f.transport);
  expect(await f.service.disconnect(host, f.transport)).toEqual({ ok: true });
  expect(f.control.service.failInterrupted).toHaveBeenCalledExactlyOnceWith('room');
  expect(f.control.service.stopRoom).not.toHaveBeenCalled();
  expect(f.rooms.end).not.toHaveBeenCalled();
  expect(f.snapshots.at(-1)).toMatchObject({
    status: 'LIVE',
    broadcast: { status: 'FAILED', errorMessage: 'Host connection lost.' },
  });
  expect(f.snapshots.at(-1)!.participants.map((p) => p.participantId)).toEqual(['host', 'human']);
  time.set(21000);
  time.callbacks[0]!();
  await vi.waitFor(() => expect(f.rooms.end).toHaveBeenCalledExactlyOnceWith('room'));
  expect(f.live.deleteRoom).toHaveBeenCalledExactlyOnceWith('sf:room:room');
  expect(f.transport.end).toHaveBeenCalledExactlyOnceWith('room');
  f.service.onModuleDestroy();
});

it('keeps a non-host broadcast live, and a resumed host cannot be controlled by the old binding', async () => {
  const time = controlledClock();
  const f = broadcastFixture('WEBINAR', time.clock);
  const host = f.client('host');
  const guest = f.client('guest');
  await f.join(host);
  await f.join(guest);
  await f.service.startBroadcast(host, f.transport);
  await f.service.disconnect(guest, f.transport);
  expect(f.control.service.failInterrupted).not.toHaveBeenCalled();
  expect(f.snapshots.at(-1)?.broadcast?.status).toBe('LIVE');
  const stale = { ...host };
  await f.service.disconnect(host, f.transport);
  const resumed = f.client('new-host', 'host');
  expect(await f.service.resume(resumed, resumeRequest('host'), f.transport)).toMatchObject({
    ok: true,
    connectionGeneration: 2,
  });
  expect(f.control.service.start).toHaveBeenCalledTimes(1);
  for (const method of ['startBroadcast', 'stopBroadcast', 'leave'] as const)
    expect(await f.service[method](stale, f.transport)).toMatchObject({ error: 'stale_transport' });
  expect(
    await f.service.update(
      stale,
      { type: 'demote', actorParticipantId: 'host', targetParticipantId: 'guest' },
      f.transport,
    ),
  ).toMatchObject({ error: 'stale_transport' });
  f.service.onModuleDestroy();
});

it('leaves a synthetic disconnect immediately without a resume credential or reservation', async () => {
  const time = controlledClock();
  const f = fixture('MEETING', undefined, undefined, undefined, undefined, time.clock);
  await f.join(f.client('host'));
  const bot = f.client('bot');
  await f.join(bot, true);
  await f.service.disconnect(bot, f.transport);
  expect(f.snapshots.at(-1)!.participants.map((p) => p.participantId)).toEqual(['host']);
  expect(time.clock.schedule).not.toHaveBeenCalled();
  f.service.onModuleDestroy();
});

it('authorizes webinar broadcast commands from the stored socket role and rejects a second start before another row', async () => {
  const f = broadcastFixture();
  const host = f.client('host');
  const guest = f.client('guest');
  await f.join(host);
  await f.join(guest);
  const before = f.snapshots.at(-1)!;
  expect(await f.service.startBroadcast(guest, f.transport)).toMatchObject({ error: 'not_host' });
  expect(await f.service.stopBroadcast(guest, f.transport)).toMatchObject({ error: 'not_host' });
  expect(f.control.service.start).not.toHaveBeenCalled();
  expect(await f.service.startBroadcast(host, f.transport)).toEqual({ ok: true });
  const after = f.snapshots.at(-1)!;
  expect(after.revision).toBeGreaterThan(before.revision);
  expect(after.stageParticipantIds).toEqual(before.stageParticipantIds);
  expect(after.participants).toEqual(before.participants);
  expect(after.broadcast).toMatchObject({ status: 'LIVE' });
  expect(await f.service.startBroadcast(host, f.transport)).toMatchObject({
    error: 'broadcast_active',
  });
  expect(f.control.service.start).toHaveBeenCalledOnce();
  expect(f.control.service.start).toHaveBeenCalledWith('room', 'host', expect.any(Object), false);
});

it('passes a guest host into the recording allowance', async () => {
  const f = broadcastFixture();
  const host = f.client('host');
  host.user.isGuest = true;
  await f.join(host);
  expect(await f.service.startBroadcast(host, f.transport)).toEqual({ ok: true });
  expect(f.control.service.start).toHaveBeenCalledWith('room', 'host', expect.any(Object), true);
});

it('does not touch the broadcast catalog or stage when a meeting start is rejected', async () => {
  const f = broadcastFixture('MEETING');
  const host = f.client('host');
  await f.join(host);
  const before = f.snapshots.at(-1);
  expect(await f.service.startBroadcast(host, f.transport)).toMatchObject({
    error: 'broadcast_not_available',
  });
  expect(f.control.service.start).not.toHaveBeenCalled();
  expect(f.control.repository.readParticipant).not.toHaveBeenCalled();
  expect(f.control.service.snapshot).not.toHaveBeenCalled();
  expect(f.control.repository.readBroadcast).not.toHaveBeenCalled();
  expect(f.snapshots.at(-1)).toBe(before);
});

it('leaves the stage intact after a missing binary and stops the broadcast before host leave deletes presence', async () => {
  const f = broadcastFixture();
  const host = f.client('host');
  await f.join(host);
  vi.mocked(f.control.service.start).mockResolvedValueOnce({
    ok: false,
    error: 'ffmpeg_unavailable',
    message: 'FFmpeg is not available. The stage is still up.',
  });
  const before = f.snapshots.at(-1)!;
  expect(await f.service.startBroadcast(host, f.transport)).toMatchObject({
    error: 'ffmpeg_unavailable',
  });
  expect(f.snapshots.at(-1)!.stageParticipantIds).toEqual(before.stageParticipantIds);
  expect(await f.service.startBroadcast(host, f.transport)).toEqual({ ok: true });
  f.events.length = 0;
  await f.service.leave(host, f.transport);
  expect(f.events.indexOf('broadcast:stop')).toBeLessThan(f.events.indexOf('apply:leave'));
  expect(f.events.indexOf('broadcast:stop')).toBeLessThan(f.events.indexOf('redis:delete'));
});
it('retries broadcast stop on host leave and does not delete the room while stop is failing', async () => {
  const logger = silenceErrors();
  try {
    const f = broadcastFixture();
    const host = f.client('host');
    const guest = f.client('guest');
    await f.join(host);
    await f.join(guest);
    expect(await f.service.startBroadcast(host, f.transport)).toEqual({ ok: true });
    vi.mocked(f.control.service.stopRoom).mockRejectedValueOnce(new Error('stop failed'));
    f.events.length = 0;
    expect(await f.service.leave(host, f.transport)).toMatchObject({
      ok: false,
      error: 'server_error',
    });
    expect(f.control.service.stopRoom).toHaveBeenCalledTimes(1);
    expect(f.live.deleteRoom).not.toHaveBeenCalled();
    expect(f.live.apply).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.anything(),
      expect.objectContaining({ type: 'leave' }),
    );
    expect(host.room).toBeDefined();
    expect(guest.room).toBeDefined();
    expect(await f.service.leave(host, f.transport)).toEqual({ ok: true });
    // The failed leave stops once. The retry stops before presence deletion and again during shutdown.
    expect(f.control.service.stopRoom).toHaveBeenCalledTimes(3);
    expect(f.events.indexOf('broadcast:stop')).toBeLessThan(f.events.indexOf('apply:leave'));
    expect(f.events.indexOf('broadcast:stop')).toBeLessThan(f.events.indexOf('redis:delete'));
    expect(host.room).toBeUndefined();
    expect(guest.room).toBeUndefined();
  } finally {
    logger.mockRestore();
  }
});
it('logs a failed broadcast exit callback without ending the room', async () => {
  const logger = silenceErrors();
  try {
    const f = broadcastFixture();
    const host = f.client('host');
    await f.join(host);
    expect(await f.service.startBroadcast(host, f.transport)).toEqual({ ok: true });
    const onChildExit = f.onChildExit();
    expect(onChildExit).toBeTypeOf('function');
    onChildExit!(async () => {
      throw new Error('exit cleanup failed');
    });
    await vi.waitFor(() => expect(logger).toHaveBeenCalledWith('exit cleanup failed'));
    expect(host.room).toBeDefined();
    expect(f.live.deleteRoom).not.toHaveBeenCalled();
    expect(f.transport.end).not.toHaveBeenCalled();
  } finally {
    logger.mockRestore();
  }
});
it('promotes a webinar attendee through only the promote repository command', async () => {
  const f = fixture('WEBINAR');
  const host = f.client('host');
  await f.join(host);
  await f.join(f.client('guest'));
  vi.mocked(f.live.apply).mockClear();
  f.snapshots.length = 0;
  const command = {
    type: 'promote',
    actorParticipantId: host.id,
    targetParticipantId: 'guest',
  } as const;
  expect(await f.service.update(host, command, f.transport)).toEqual({ ok: true });
  expect(f.live.apply).toHaveBeenCalledExactlyOnceWith('sf:room:room', host.room, {
    ...command,
    transport: { participantId: 'host', socketId: 'host', generation: 1 },
  });
  expect(f.snapshots).toHaveLength(1);
  expect(f.snapshots[0]?.participants.find((p) => p.participantId === 'guest')?.role).toBe(
    'SPEAKER',
  );
  expect(f.transport.forceMute).not.toHaveBeenCalled();
});
it('does not publish when the promote script rejects a full stage', async () => {
  const f = fixture('WEBINAR');
  const host = f.client('host');
  await f.join(host);
  vi.mocked(f.live.apply).mockResolvedValueOnce({ ok: false, error: 'stage_full', revision: 1 });
  f.snapshots.length = 0;
  expect(
    await f.service.update(
      host,
      {
        type: 'promote',
        actorParticipantId: host.id,
        targetParticipantId: 'guest',
      },
      f.transport,
    ),
  ).toMatchObject({ ok: false, error: 'stage_full' });
  expect(f.snapshots).toHaveLength(0);
  expect(f.transport.forceMute).not.toHaveBeenCalled();
});
it('rejects demoting the host and a non-host promote without publishing', async () => {
  const f = fixture('WEBINAR');
  const host = f.client('host'),
    guest = f.client('guest');
  await f.join(host);
  await f.join(guest);
  f.snapshots.length = 0;
  expect(
    await f.service.update(
      host,
      {
        type: 'demote',
        actorParticipantId: host.id,
        targetParticipantId: host.id,
      },
      f.transport,
    ),
  ).toMatchObject({ ok: false, error: 'cannot_demote_host' });
  expect(
    await f.service.update(
      guest,
      {
        type: 'promote',
        actorParticipantId: guest.id,
        targetParticipantId: guest.id,
      },
      f.transport,
    ),
  ).toMatchObject({ ok: false, error: 'not_host' });
  expect(f.snapshots).toHaveLength(0);
});
it.each(['audio', 'video'] as const)(
  'targets changed %s locks before snapshot and suppresses no-ops',
  async (kind) => {
    const f = fixture('WEBINAR');
    const host = f.client('host');
    await f.join(host);
    await f.join(f.client('guest'));
    f.events.length = 0;
    f.snapshots.length = 0;
    const command = {
      type: 'setHostLock',
      actorParticipantId: host.id,
      targetParticipantId: 'guest',
      kind,
      locked: true,
    } as const;
    expect(await f.service.update(host, command, f.transport)).toEqual({ ok: true });
    expect(f.transport.forceMute).toHaveBeenCalledExactlyOnceWith('guest', { kind, locked: true });
    expect(f.events).toEqual(['apply:setHostLock', 'force-mute:guest', 'publish']);
    expect(f.snapshots).toHaveLength(1);
    expect(f.snapshots[0]?.participants.find((p) => p.participantId === 'guest')).toMatchObject(
      kind === 'audio'
        ? { hostAudioLocked: true, isAudioMuted: true }
        : { hostVideoLocked: true, isVideoOff: true },
    );
    expect(await f.service.update(host, command, f.transport)).toEqual({ ok: true });
    expect(f.transport.forceMute).toHaveBeenCalledTimes(1);
    expect(f.snapshots).toHaveLength(1);
    expect(await f.service.update(host, { ...command, locked: false }, f.transport)).toEqual({
      ok: true,
    });
    expect(f.transport.forceMute).toHaveBeenLastCalledWith('guest', { kind, locked: false });
    expect(f.snapshots).toHaveLength(2);
  },
);
it('rejects meeting broadcast commands before any repository or transport access', async () => {
  const f = fixture();
  const host = f.client('host');
  host.room = { roomId: 'room', hostId: 'host', mode: 'MEETING', status: 'LIVE' };
  for (const action of ['startBroadcast', 'stopBroadcast'] as const) {
    expect(await f.service[action](host, f.transport)).toEqual({
      ok: false,
      error: 'broadcast_not_available',
      message: 'Broadcast is not available yet.',
    });
  }
  for (const repository of [f.live, f.rooms]) {
    for (const method of Object.values(repository)) expect(method).not.toHaveBeenCalled();
  }
  expect(f.events).toEqual([]);
});
it('uses the configured namespace for join, media, relay checks and shutdown', async () => {
  const f = fixture('MEETING', { isReady: () => true }, 'preview-blue');
  const host = f.client('host');
  await f.join(host);
  expect(f.live.apply).toHaveBeenCalledWith(
    'preview-blue:room:room',
    expect.anything(),
    expect.objectContaining({ type: 'join' }),
  );
  await f.join(f.client('guest'));
  await f.service.update(
    host,
    { type: 'patchMedia', participantId: host.id, patch: { isAudioMuted: true } },
    f.transport,
  );
  expect(f.live.apply).toHaveBeenLastCalledWith(
    'preview-blue:room:room',
    expect.anything(),
    expect.objectContaining({ type: 'patchMedia' }),
  );
  expect(await f.service.relay(host, 'guest', f.transport, vi.fn())).toEqual({ ok: true });
  expect(f.live.readConnectedStage).toHaveBeenCalledWith('preview-blue:room:room');
  await f.service.leave(host, f.transport);
  expect(f.live.apply).toHaveBeenLastCalledWith(
    'preview-blue:room:room',
    expect.anything(),
    expect.objectContaining({ type: 'leave' }),
  );
  expect(f.live.deleteRoom).toHaveBeenCalledWith('preview-blue:room:room');
});
it('rejects live commands while Redis readiness is down', async () => {
  const availability = { ready: false, isReady: () => availability.ready };
  const f = fixture('MEETING', availability);
  const host = f.client('host');
  expect(await f.join(host)).toMatchObject({ ok: false, error: 'server_error' });
  expect(f.rooms.getById).not.toHaveBeenCalled();
  expect(f.live.apply).not.toHaveBeenCalled();
  expect(f.transport.join).not.toHaveBeenCalled();
  availability.ready = true;
  expect(await f.join(host)).toEqual({ ok: true });
});
it('uses trusted session identity, joins before snapshot, and suppresses no-op publications', async () => {
  const f = fixture();
  const host = f.client('host');
  expect(await f.join(host)).toEqual({ ok: true });
  expect(f.events).toEqual(['apply:join', 'join:host', 'publish']);
  expect(f.snapshots[0]?.participants[0]).toMatchObject({
    userId: 'host',
    displayName: 'host',
    role: 'HOST',
  });
  await f.service.update(
    host,
    { type: 'patchMedia', participantId: host.id, patch: {} },
    f.transport,
  );
  expect(f.snapshots).toHaveLength(1);
  expect(await f.join(host)).toMatchObject({ ok: false, error: 'already_joined' });
});
it('delivers a committed join after broadcast enrichment fails once', async () => {
  const logger = silenceErrors();
  try {
    const f = broadcastFixture();
    const host = f.client('host');
    vi.mocked(f.control.service.snapshot).mockRejectedValueOnce(new Error('catalog down'));
    expect(await f.join(host)).toMatchObject({ ok: false, error: 'server_error' });
    expect(host.room?.roomId).toBe('room');
    expect(f.transport.join).toHaveBeenCalledTimes(1);
    expect(f.snapshots).toHaveLength(0);
    const applies = vi.mocked(f.live.apply).mock.calls.length;
    expect(await f.join(host)).toEqual({ ok: true });
    expect(vi.mocked(f.live.apply).mock.calls.length).toBe(applies);
    expect(f.transport.join).toHaveBeenCalledTimes(1);
    expect(f.snapshots).toHaveLength(1);
    expect(f.snapshots[0]).toMatchObject({
      revision: 1,
      participants: [expect.objectContaining({ participantId: 'host', role: 'HOST' })],
    });
    expect(await f.join(host)).toMatchObject({ ok: false, error: 'already_joined' });
    expect(f.snapshots).toHaveLength(1);
    expect(vi.mocked(f.live.apply).mock.calls.length).toBe(applies);
  } finally {
    logger.mockRestore();
  }
});
it('delivers a committed media change after publication fails without another catalog read', async () => {
  const logger = silenceErrors();
  try {
    const f = broadcastFixture();
    const host = f.client('host');
    await f.join(host);
    expect(f.control.service.snapshot).toHaveBeenCalledTimes(1);
    expect(f.control.repository.readBroadcast).toHaveBeenCalledTimes(1);
    vi.mocked(f.transport.publish).mockImplementationOnce(() => {
      throw new Error('socket down');
    });
    const patch = {
      type: 'patchMedia',
      participantId: host.id,
      patch: { isAudioMuted: true },
    } as const;
    expect(await f.service.update(host, patch, f.transport)).toMatchObject({
      ok: false,
      error: 'server_error',
    });
    expect(f.snapshots).toHaveLength(1);
    expect(f.control.service.snapshot).toHaveBeenCalledTimes(1);
    expect(f.control.repository.readBroadcast).toHaveBeenCalledTimes(1);
    const applies = vi.mocked(f.live.apply).mock.calls.length;
    expect(await f.service.update(host, patch, f.transport)).toEqual({ ok: true });
    expect(vi.mocked(f.live.apply).mock.calls.length).toBe(applies + 1);
    expect(f.snapshots).toHaveLength(2);
    expect(f.snapshots[1]).toMatchObject({
      revision: 2,
      participants: [expect.objectContaining({ participantId: 'host', isAudioMuted: true })],
    });
    expect(f.control.service.snapshot).toHaveBeenCalledTimes(1);
    expect(f.control.repository.readBroadcast).toHaveBeenCalledTimes(1);
    expect(
      await f.service.update(
        host,
        { type: 'patchMedia', participantId: host.id, patch: { isAudioMuted: false } },
        f.transport,
      ),
    ).toEqual({ ok: true });
    expect(f.snapshots.at(-1)?.participants[0]).toMatchObject({ isAudioMuted: false });
    expect(f.control.service.snapshot).toHaveBeenCalledTimes(1);
    expect(f.control.repository.readBroadcast).toHaveBeenCalledTimes(1);
  } finally {
    logger.mockRestore();
  }
});
it('enforces stage-only relay and checks live target association', async () => {
  const f = fixture('WEBINAR');
  const host = f.client('host'),
    guest = f.client('guest');
  await f.join(host);
  await f.join(guest);
  const send = vi.fn();
  expect(await f.service.relay(guest, host.id, f.transport, send)).toMatchObject({
    ok: false,
    error: 'not_on_stage',
  });
  expect(send).not.toHaveBeenCalled();
  const m = fixture();
  const a = m.client('host'),
    b = m.client('speaker');
  await m.join(a);
  await m.join(b);
  expect(await m.service.relay(a, b.id, m.transport, send)).toEqual({ ok: true });
  expect(send).toHaveBeenCalledTimes(1);
  b.room = undefined;
  expect(await m.service.relay(a, b.id, m.transport, send)).toMatchObject({
    ok: false,
    error: 'peer_unavailable',
  });
});
it('publishes guest leave before transport removal and keeps leave idempotent', async () => {
  const f = fixture();
  await f.join(f.client('host'));
  const guest = f.client('guest');
  await f.join(guest);
  f.events.length = 0;
  expect(await f.service.leave(guest, f.transport)).toEqual({ ok: true });
  expect(f.events).toEqual(['apply:leave', 'publish', 'leave:guest']);
  expect(guest.room).toBeUndefined();
  expect(await f.service.leave(guest, f.transport)).toEqual({ ok: true });
  expect(f.events).toHaveLength(3);
});
it('preserves host leave persistence/effect order and clears every association', async () => {
  const f = fixture();
  const host = f.client('host'),
    guest = f.client('guest');
  await f.join(host);
  await f.join(guest);
  f.events.length = 0;
  expect(await f.service.leave(host, f.transport)).toEqual({ ok: true });
  expect(f.events).toEqual(['apply:leave', 'database:end', 'redis:delete', 'transport:end']);
  expect(guest.room).toBeUndefined();
  expect(host.room).toBeUndefined();
  expect(await f.service.leave(host, f.transport)).toEqual({ ok: true });
  expect(f.rooms.end).toHaveBeenCalledTimes(1);
  expect(f.live.deleteRoom).toHaveBeenCalledTimes(1);
  expect(f.transport.end).toHaveBeenCalledTimes(1);
});
it('completes host shutdown on retry when catalog ending fails first', async () => {
  const logger = silenceErrors();
  try {
    const f = fixture();
    const host = f.client('host'),
      guest = f.client('guest');
    await f.join(host);
    await f.join(guest);
    f.events.length = 0;
    vi.mocked(f.rooms.end).mockRejectedValueOnce(new Error('database unavailable'));
    expect(await f.service.leave(host, f.transport)).toMatchObject({
      ok: false,
      error: 'server_error',
    });
    expect(f.events).toEqual(['apply:leave']);
    expect(f.live.deleteRoom).not.toHaveBeenCalled();
    expect(f.transport.end).not.toHaveBeenCalled();
    expect(host.room).toBeDefined();
    expect(guest.room).toBeDefined();
    expect(await f.join(f.client('late'))).toMatchObject({ ok: false, error: 'room_ended' });
    expect(f.live.apply).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.anything(),
      expect.objectContaining({ participantId: 'late' }),
    );
    const applies = vi.mocked(f.live.apply).mock.calls.length;
    expect(await f.service.leave(host, f.transport)).toEqual({ ok: true });
    expect(vi.mocked(f.live.apply).mock.calls.length).toBe(applies);
    expect(f.events).toEqual(['apply:leave', 'database:end', 'redis:delete', 'transport:end']);
    expect(f.rooms.end).toHaveBeenCalledTimes(2);
    expect(guest.room).toBeUndefined();
    expect(host.room).toBeUndefined();
    expect(await f.rooms.getById('room')).toMatchObject({ status: 'ENDED' });
    expect(logger).toHaveBeenCalledWith(
      expect.stringContaining('Incomplete shutdown for room room: database unavailable'),
    );
  } finally {
    logger.mockRestore();
  }
});
it('finishes shutdown from a guest leave after the host participant is gone', async () => {
  const logger = silenceErrors();
  try {
    const f = fixture();
    const host = f.client('host'),
      guest = f.client('guest');
    await f.join(host);
    await f.join(guest);
    vi.mocked(f.rooms.end).mockRejectedValueOnce(new Error('database unavailable'));
    expect(await f.service.leave(host, f.transport)).toMatchObject({
      ok: false,
      error: 'server_error',
    });
    expect(await f.service.leave(guest, f.transport)).toEqual({ ok: true });
    expect(f.transport.end).toHaveBeenCalledTimes(1);
    expect(host.room).toBeUndefined();
    expect(guest.room).toBeUndefined();
    expect(await f.rooms.getById('room')).toMatchObject({ status: 'ENDED' });
  } finally {
    logger.mockRestore();
  }
});
it('retries key deletion without notifying while Redis deletion is failing', async () => {
  const logger = silenceErrors();
  try {
    const f = fixture();
    const host = f.client('host'),
      guest = f.client('guest');
    await f.join(host);
    await f.join(guest);
    vi.mocked(f.live.deleteRoom).mockRejectedValueOnce(new Error('redis unavailable'));
    expect(await f.service.leave(host, f.transport)).toMatchObject({
      ok: false,
      error: 'server_error',
    });
    expect(f.transport.end).not.toHaveBeenCalled();
    expect(guest.room).toBeDefined();
    expect(await f.rooms.getById('room')).toMatchObject({ status: 'ENDED' });
    expect(await f.service.leave(host, f.transport)).toEqual({ ok: true });
    expect(f.live.deleteRoom).toHaveBeenCalledTimes(2);
    expect(f.transport.end).toHaveBeenCalledTimes(1);
    expect(guest.room).toBeUndefined();
    expect(logger).toHaveBeenCalledWith(
      expect.stringContaining('Incomplete shutdown for room room: redis unavailable'),
    );
  } finally {
    logger.mockRestore();
  }
});
it('retries notification after Redis deletion without another participant lookup', async () => {
  const logger = silenceErrors();
  try {
    const f = fixture();
    const host = f.client('host'),
      guest = f.client('guest');
    await f.join(host);
    await f.join(guest);
    vi.mocked(f.transport.end).mockRejectedValueOnce(new Error('notify failed'));
    expect(await f.service.leave(host, f.transport)).toMatchObject({
      ok: false,
      error: 'server_error',
    });
    expect(guest.room).toBeDefined();
    expect(host.room).toBeDefined();
    vi.mocked(f.live.apply).mockResolvedValueOnce({
      ok: true,
      changed: false,
      roomEnded: false,
      revision: 3,
      state: {
        roomId: 'room',
        hostId: 'host',
        mode: 'MEETING',
        status: 'LIVE',
        participants: [],
        stageParticipantIds: [],
        waitingParticipantIds: [],
        hands: [],
        resumeDigests: {},
        deadlines: {},
      },
    });
    expect(await f.service.leave(host, f.transport)).toEqual({ ok: true });
    expect(f.live.apply).toHaveBeenCalledTimes(3);
    expect(f.transport.end).toHaveBeenCalledTimes(2);
    expect(guest.room).toBeUndefined();
    expect(host.room).toBeUndefined();
  } finally {
    logger.mockRestore();
  }
});
it('keeps the room joinable when leave fails before ending intent is recorded', async () => {
  const logger = silenceErrors();
  try {
    const f = fixture();
    const host = f.client('host'),
      guest = f.client('guest');
    await f.join(host);
    await f.join(guest);
    vi.mocked(f.live.apply).mockRejectedValueOnce(new Error('redis unavailable'));
    expect(await f.service.leave(host, f.transport)).toMatchObject({
      ok: false,
      error: 'server_error',
    });
    expect(f.rooms.end).not.toHaveBeenCalled();
    expect(f.live.deleteRoom).not.toHaveBeenCalled();
    expect(f.transport.end).not.toHaveBeenCalled();
    expect(host.room).toBeDefined();
    expect(guest.room).toBeDefined();
    expect(logger).toHaveBeenCalledWith('redis unavailable');
    expect(await f.join(f.client('late'))).toEqual({ ok: true });
    expect(await f.service.leave(host, f.transport)).toEqual({ ok: true });
    expect(guest.room).toBeUndefined();
    expect(await f.rooms.getById('room')).toMatchObject({ status: 'ENDED' });
  } finally {
    logger.mockRestore();
  }
});
it('completes a disconnect leave queued behind a failing host leave', async () => {
  const logger = silenceErrors();
  try {
    const f = fixture();
    const host = f.client('host'),
      guest = f.client('guest');
    await f.join(host);
    await f.join(guest);
    let rejectEnd!: (error: Error) => void;
    vi.mocked(f.rooms.end).mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectEnd = reject;
        }),
    );
    const first = f.service.leave(host, f.transport);
    await vi.waitFor(() => expect(f.rooms.end).toHaveBeenCalledTimes(1));
    const disconnected = f.service.leave(host, f.transport);
    rejectEnd(new Error('database unavailable'));
    expect(await first).toMatchObject({ ok: false, error: 'server_error' });
    expect(await disconnected).toEqual({ ok: true });
    expect(f.transport.end).toHaveBeenCalledTimes(1);
    expect(guest.room).toBeUndefined();
    expect(host.room).toBeUndefined();
    expect(await f.rooms.getById('room')).toMatchObject({ status: 'ENDED' });
  } finally {
    logger.mockRestore();
  }
});
it('maps failed admission without transport effects', async () => {
  const f = fixture();
  vi.mocked(f.rooms.getById).mockResolvedValueOnce(null);
  expect(await f.join(f.client('guest'))).toMatchObject({ ok: false, error: 'room_not_found' });
  expect(f.live.apply).not.toHaveBeenCalled();
  expect(f.transport.join).not.toHaveBeenCalled();
});

it('rejects a queued guest update after host leave clears its association', async () => {
  const f = fixture();
  const host = f.client('host'),
    guest = f.client('guest');
  await f.join(host);
  await f.join(guest);
  f.events.length = 0;
  const ending = f.service.leave(host, f.transport);
  const updating = f.service.update(
    guest,
    { type: 'patchMedia', participantId: guest.id, patch: { isVideoOff: true } },
    f.transport,
  );
  expect(await ending).toEqual({ ok: true });
  expect(await updating).toMatchObject({ ok: false, error: 'room_ended' });
  expect(f.events).not.toContain('apply:patchMedia');
});

it('rejects a burst early while allowing disconnected-host cleanup through reserved capacity', async () => {
  const queue = new SerializedOperations({ maxPending: 1, maxPerKey: 1, cleanupReserve: 1 });
  const f = fixture('MEETING', { isReady: () => true }, 'burst', queue);
  const host = f.client('host'),
    guest = f.client('guest');
  await f.join(host);
  await f.join(guest);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const apply = vi.mocked(f.live.apply).getMockImplementation()!;
  vi.mocked(f.live.apply).mockImplementationOnce(async (...args) => {
    await gate;
    return apply(...args);
  });
  const active = f.service.update(
    host,
    { type: 'patchMedia', participantId: host.id, patch: { isVideoOff: true } },
    f.transport,
  );
  await vi.waitFor(() => expect(f.live.apply).toHaveBeenCalledTimes(3));
  const burst = await Promise.all(
    Array.from({ length: 50 }, () =>
      f.service.update(
        guest,
        { type: 'patchMedia', participantId: guest.id, patch: {} },
        f.transport,
      ),
    ),
  );
  expect(burst.every((result) => !result.ok && result.error === 'server_busy')).toBe(true);
  expect(f.live.apply).toHaveBeenCalledTimes(3);
  Object.defineProperty(host, 'connected', { value: false });
  const leaving = f.service.leave(host, f.transport);
  const retry = f.service.leave(host, f.transport);
  expect(f.service.leave(host, f.transport)).toBe(retry);
  release();
  expect(await active).toEqual({ ok: true });
  expect(await leaving).toEqual({ ok: true });
  expect(await retry).toEqual({ ok: true });
  expect(f.transport.end).toHaveBeenCalledTimes(1);
  expect(guest.room).toBeUndefined();
});

it('suspends through reserved capacity when normal room work is full and starts grace at detection', async () => {
  const time = controlledClock();
  const queue = new SerializedOperations({ maxPending: 1, maxPerKey: 1, cleanupReserve: 1 });
  const f = fixture('MEETING', undefined, undefined, queue, undefined, time.clock);
  await f.join(f.client('host'));
  const guest = f.client('guest');
  await f.join(guest);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const active = queue.run('room:room', () => gate);
  Object.defineProperty(guest, 'connected', { value: false });
  const dropping = f.service.disconnect(guest, f.transport);
  time.set(1900);
  release();
  await active;
  expect(await dropping).toEqual({ ok: true });
  expect(f.live.apply).toHaveBeenLastCalledWith(
    expect.anything(),
    expect.anything(),
    expect.objectContaining({ type: 'suspend', now: 1000 }),
  );
  expect(f.rooms.end).not.toHaveBeenCalled();
  time.set(21000);
  await f.service.sweep();
  expect(f.snapshots.at(-1)!.participants.map((p) => p.participantId)).toEqual(['host']);
  f.service.onModuleDestroy();
});

it('retries failed host-expiry shutdown and rejects joins until catalog cleanup succeeds', async () => {
  const logger = silenceErrors();
  const time = controlledClock();
  const f = fixture('MEETING', undefined, undefined, undefined, undefined, time.clock);
  try {
    const host = f.client('host');
    await f.join(host);
    await f.service.disconnect(host, f.transport);
    time.set(21000);
    vi.mocked(f.rooms.end).mockRejectedValueOnce(new Error('catalog unavailable'));
    expect(await f.service.expire('room')).toMatchObject({ error: 'server_error' });
    expect(f.transport.end).not.toHaveBeenCalled();
    expect(await f.join(f.client('late'))).toMatchObject({ error: 'room_ended' });
    await f.service.sweep();
    expect(f.rooms.end).toHaveBeenCalledTimes(2);
    expect(f.transport.end).toHaveBeenCalledExactlyOnceWith('room');
    expect(f.live.deleteRoom).toHaveBeenCalledExactlyOnceWith('sf:room:room');
  } finally {
    f.service.onModuleDestroy();
    logger.mockRestore();
  }
});

it('deletes chat after stage keys and retries a chat deletion failure before ending the transport', async () => {
  const logger = silenceErrors();
  const f = fixture();
  try {
    const host = f.client('host'),
      guest = f.client('guest');
    await f.join(host);
    await f.join(guest);
    f.events.length = 0;
    f.chat.delete.mockRejectedValueOnce(new Error('chat deletion unavailable'));
    expect(await f.service.leave(host, f.transport)).toMatchObject({ error: 'server_error' });
    expect(f.events).toEqual(['apply:leave', 'database:end', 'redis:delete']);
    expect(f.chat.delete).toHaveBeenCalledExactlyOnceWith('sf:room:room');
    expect(f.transport.end).not.toHaveBeenCalled();
    expect(host.room).toBeDefined();
    expect(guest.room).toBeDefined();
    expect(await f.join(f.client('late'))).toMatchObject({ error: 'room_ended' });
    f.chat.delete.mockImplementationOnce(async () => {
      f.events.push('chat:delete');
    });
    expect(await f.service.leave(host, f.transport)).toEqual({ ok: true });
    expect(f.events.slice(-4)).toEqual([
      'database:end',
      'redis:delete',
      'chat:delete',
      'transport:end',
    ]);
    expect(f.chat.delete).toHaveBeenCalledTimes(2);
    expect(f.live.deleteRoom).toHaveBeenCalledTimes(2);
    expect(f.live.apply).toHaveBeenCalledTimes(3);
    expect(host.room).toBeUndefined();
    expect(guest.room).toBeUndefined();
    expect(await f.service.leave(host, f.transport)).toEqual({ ok: true });
    expect(f.chat.delete).toHaveBeenCalledTimes(2);
  } finally {
    logger.mockRestore();
  }
});

it('retries chat cleanup after host expiry and keeps the interrupted broadcast failed', async () => {
  const logger = silenceErrors();
  const time = controlledClock();
  const f = broadcastFixture('WEBINAR', time.clock);
  try {
    const host = f.client('host');
    await f.join(host);
    await f.service.startBroadcast(host, f.transport);
    await f.service.disconnect(host, f.transport);
    expect(f.snapshots.at(-1)?.broadcast?.status).toBe('FAILED');
    f.chat.delete.mockRejectedValueOnce(new Error('chat deletion unavailable'));
    time.set(21000);
    expect(await f.service.expire('room')).toMatchObject({ error: 'server_error' });
    expect(f.live.deleteRoom).toHaveBeenCalledExactlyOnceWith('sf:room:room');
    expect(f.transport.end).not.toHaveBeenCalled();
    expect(f.chat.delete).toHaveBeenCalledExactlyOnceWith('sf:room:room');
    await f.service.sweep();
    expect(f.chat.delete).toHaveBeenCalledTimes(2);
    expect(f.transport.end).toHaveBeenCalledExactlyOnceWith('room');
    expect(f.control.service.failInterrupted).toHaveBeenCalledOnce();
    expect(await f.control.service.snapshot('room', null)).toMatchObject({ status: 'FAILED' });
    expect(f.snapshots.some((snapshot) => snapshot.broadcast?.status === 'READY')).toBe(false);
  } finally {
    f.service.onModuleDestroy();
    logger.mockRestore();
  }
});

function dropSocket(peer: LiveSession): void {
  Object.defineProperty(peer, 'connected', { value: false, configurable: true });
}

function pause(): {
  promise: Promise<void>;
  entered: Promise<void>;
  enter(): void;
  release(): void;
} {
  let release!: () => void;
  let enter!: () => void;
  return {
    promise: new Promise<void>((resolve) => {
      release = resolve;
    }),
    entered: new Promise<void>((resolve) => {
      enter = resolve;
    }),
    enter: () => enter(),
    release: () => release(),
  };
}

async function disconnectDuring(peer: LiveSession, service: LiveService, transport: LiveTransport) {
  dropSocket(peer);
  await service.disconnect(peer, transport);
}

it('does not admit a guest when the socket dies before the catalog read returns', async () => {
  const f = fixture();
  await f.join(f.client('host'));
  const guest = f.client('guest');
  const held = pause();
  const read = vi.mocked(f.rooms.getById).getMockImplementation()!;
  vi.mocked(f.rooms.getById).mockImplementationOnce(async (...args) => {
    held.enter();
    await held.promise;
    return read(...args);
  });
  const joining = f.join(guest);
  await held.entered;
  await disconnectDuring(guest, f.service, f.transport);
  held.release();
  expect(await joining).toMatchObject({ ok: false, error: 'not_joined' });
  expect(f.live.apply).not.toHaveBeenCalledWith(
    expect.anything(),
    expect.anything(),
    expect.objectContaining({ type: 'join', participantId: 'guest' }),
  );
  expect(f.snapshots.at(-1)!.participants.map((p) => p.participantId)).toEqual(['host']);
  expect(f.events).not.toContain('join:guest');
  f.service.onModuleDestroy();
});

it('suspends a guest joined after the socket died and releases that slot when grace ends', async () => {
  const time = controlledClock();
  const f = fixture('MEETING', undefined, undefined, undefined, undefined, time.clock);
  await f.join(f.client('host'));
  const guest = f.client('guest');
  const held = pause();
  const apply = vi.mocked(f.live.apply).getMockImplementation()!;
  vi.mocked(f.live.apply).mockImplementation(async (...args) => {
    const command = args[2];
    if (command.type === 'join' && command.participantId === 'guest') {
      held.enter();
      await held.promise;
    }
    return apply(...args);
  });
  const joining = f.join(guest);
  await held.entered;
  await disconnectDuring(guest, f.service, f.transport);
  time.set(1800);
  const before = f.snapshots.length;
  held.release();
  expect(await joining).toMatchObject({ ok: false, error: 'not_joined' });
  expect(f.live.apply).toHaveBeenCalledWith(
    'sf:room:room',
    expect.anything(),
    expect.objectContaining({
      type: 'suspend',
      participantId: 'guest',
      now: 1000,
      transport: { participantId: 'guest', socketId: 'guest', generation: 1 },
    }),
  );
  expect(
    f.snapshots
      .slice(before)
      .some((snapshot) =>
        snapshot.participants.some(
          (p) => p.participantId === 'guest' && p.presence === 'connected',
        ),
      ),
  ).toBe(false);
  expect(f.snapshots.at(-1)!.participants.find((p) => p.participantId === 'guest')).toMatchObject({
    presence: 'suspended',
    socketId: null,
  });
  expect(f.snapshots.at(-1)!.stageParticipantIds).toContain('guest');
  expect(f.events).not.toContain('join:guest');
  expect(await f.join(f.client('other', 'guest'))).toMatchObject({ error: 'already_joined' });
  time.set(20999);
  await f.service.sweep();
  expect(
    f.snapshots
      .at(-1)!
      .participants.map((p) => p.participantId)
      .sort(),
  ).toEqual(['guest', 'host']);
  time.set(21000);
  await f.service.sweep();
  expect(f.snapshots.at(-1)!.participants.map((p) => p.participantId)).toEqual(['host']);
  expect(f.rooms.end).not.toHaveBeenCalled();
  f.service.onModuleDestroy();
});

it('keeps host grace when the socket dies after join commits and before association', async () => {
  const time = controlledClock();
  const f = fixture('MEETING', undefined, undefined, undefined, undefined, time.clock);
  const host = f.client('host');
  const held = pause();
  const apply = vi.mocked(f.live.apply).getMockImplementation()!;
  vi.mocked(f.live.apply).mockImplementationOnce(async (...args) => {
    const result = await apply(...args);
    held.enter();
    await held.promise;
    return result;
  });
  const joining = f.join(host);
  await held.entered;
  await disconnectDuring(host, f.service, f.transport);
  time.set(1800);
  held.release();
  expect(await joining).toMatchObject({ ok: false, error: 'not_joined' });
  expect(f.events).not.toContain('join:host');
  expect(f.snapshots.at(-1)).toMatchObject({ status: 'LIVE' });
  expect(f.snapshots.at(-1)!.participants).toEqual([
    expect.objectContaining({
      participantId: 'host',
      role: 'HOST',
      presence: 'suspended',
      socketId: null,
    }),
  ]);
  expect(f.live.apply).toHaveBeenCalledWith(
    expect.anything(),
    expect.anything(),
    expect.objectContaining({ type: 'suspend', participantId: 'host', now: 1000 }),
  );
  expect(f.rooms.end).not.toHaveBeenCalled();
  time.set(20999);
  await f.service.sweep();
  expect(f.rooms.end).not.toHaveBeenCalled();
  expect(f.readState().participants.map((p) => p.participantId)).toEqual(['host']);
  time.set(21000);
  await f.service.sweep();
  expect(f.rooms.end).toHaveBeenCalledExactlyOnceWith('room');
  expect(f.readState().status).toBe('ENDED');
  expect(f.readState().participants).toEqual([]);
  f.service.onModuleDestroy();
});

it('suspends a join whose Redis reply is lost after the socket is already gone', async () => {
  const logger = silenceErrors();
  const time = controlledClock();
  const f = fixture('MEETING', undefined, undefined, undefined, undefined, time.clock);
  try {
    const host = f.client('host');
    const apply = vi.mocked(f.live.apply).getMockImplementation()!;
    vi.mocked(f.live.apply).mockImplementationOnce(async (...args) => {
      await apply(...args);
      await disconnectDuring(host, f.service, f.transport);
      throw new Error('reply lost');
    });
    expect(await f.join(host)).toMatchObject({ ok: false, error: 'server_error' });
    expect(f.events).not.toContain('join:host');
    expect(f.readState().participants).toEqual([
      expect.objectContaining({ participantId: 'host', presence: 'suspended', socketId: null }),
    ]);
    expect(f.readState().deadlines.host).toBe(21000);
    time.set(21000);
    await f.service.sweep();
    expect(f.rooms.end).toHaveBeenCalledExactlyOnceWith('room');
  } finally {
    f.service.onModuleDestroy();
    logger.mockRestore();
  }
});

it('leaves an existing suspension in place when resume dies before the catalog read returns', async () => {
  const time = controlledClock();
  const f = fixture('MEETING', undefined, undefined, undefined, undefined, time.clock);
  await f.join(f.client('host'));
  const guest = f.client('guest');
  await f.join(guest);
  await f.service.disconnect(guest, f.transport);
  const next = f.client('returning', 'guest');
  const held = pause();
  const read = vi.mocked(f.rooms.getById).getMockImplementation()!;
  vi.mocked(f.rooms.getById).mockImplementationOnce(async (...args) => {
    held.enter();
    await held.promise;
    return read(...args);
  });
  const resuming = f.service.resume(next, resumeRequest('guest'), f.transport);
  await held.entered;
  await disconnectDuring(next, f.service, f.transport);
  time.set(5000);
  held.release();
  expect(await resuming).toMatchObject({ ok: false, error: 'not_joined' });
  expect(f.live.apply).not.toHaveBeenCalledWith(
    expect.anything(),
    expect.anything(),
    expect.objectContaining({ type: 'resume' }),
  );
  expect(f.readState().participants.find((p) => p.participantId === 'guest')).toMatchObject({
    presence: 'suspended',
    connectionGeneration: 1,
    socketId: null,
  });
  expect(f.readState().deadlines.guest).toBe(21000);
  expect(f.events).not.toContain('join:returning');
  time.set(21000);
  await f.service.sweep();
  expect(f.readState().participants.map((p) => p.participantId)).toEqual(['host']);
  f.service.onModuleDestroy();
});

it('suspends a resume that commits after its socket has disconnected', async () => {
  const time = controlledClock();
  const f = fixture('MEETING', undefined, undefined, undefined, undefined, time.clock);
  await f.join(f.client('host'));
  const guest = f.client('guest');
  await f.join(guest);
  await f.service.disconnect(guest, f.transport);
  const next = f.client('returning', 'guest');
  const held = pause();
  const apply = vi.mocked(f.live.apply).getMockImplementation()!;
  vi.mocked(f.live.apply).mockImplementation(async (...args) => {
    const command = args[2];
    if (command.type === 'resume') {
      held.enter();
      await held.promise;
    }
    return apply(...args);
  });
  time.set(5000);
  const resuming = f.service.resume(next, resumeRequest('guest'), f.transport);
  await held.entered;
  await disconnectDuring(next, f.service, f.transport);
  time.set(8000);
  const before = f.snapshots.length;
  held.release();
  expect(await resuming).toMatchObject({ ok: false, error: 'not_joined' });
  expect(f.live.apply).toHaveBeenCalledWith(
    expect.anything(),
    expect.anything(),
    expect.objectContaining({
      type: 'suspend',
      participantId: 'guest',
      now: 5000,
      transport: { participantId: 'guest', socketId: 'returning', generation: 2 },
    }),
  );
  expect(
    f.snapshots
      .slice(before)
      .some((snapshot) =>
        snapshot.participants.some(
          (p) => p.participantId === 'guest' && p.presence === 'connected',
        ),
      ),
  ).toBe(false);
  expect(f.readState().participants.find((p) => p.participantId === 'guest')).toMatchObject({
    presence: 'suspended',
    connectionGeneration: 2,
    socketId: null,
  });
  expect(f.readState().deadlines.guest).toBe(25000);
  expect(f.events).not.toContain('join:returning');
  time.set(24999);
  await f.service.sweep();
  expect(
    f
      .readState()
      .participants.map((p) => p.participantId)
      .sort(),
  ).toEqual(['guest', 'host']);
  time.set(25000);
  await f.service.sweep();
  expect(f.readState().participants.map((p) => p.participantId)).toEqual(['host']);
  f.service.onModuleDestroy();
});

it('suspends a resume that committed before the socket was associated', async () => {
  const time = controlledClock();
  const f = fixture('MEETING', undefined, undefined, undefined, undefined, time.clock);
  await f.join(f.client('host'));
  const guest = f.client('guest');
  await f.join(guest);
  await f.service.disconnect(guest, f.transport);
  const next = f.client('returning', 'guest');
  const held = pause();
  const apply = vi.mocked(f.live.apply).getMockImplementation()!;
  vi.mocked(f.live.apply).mockImplementation(async (...args) => {
    if (args[2].type !== 'resume') return apply(...args);
    const result = await apply(...args);
    held.enter();
    await held.promise;
    return result;
  });
  time.set(5000);
  const resuming = f.service.resume(next, resumeRequest('guest'), f.transport);
  await held.entered;
  await disconnectDuring(next, f.service, f.transport);
  time.set(8000);
  held.release();
  expect(await resuming).toMatchObject({ ok: false, error: 'not_joined' });
  expect(f.readState().participants.find((p) => p.participantId === 'guest')).toMatchObject({
    presence: 'suspended',
    connectionGeneration: 2,
    socketId: null,
  });
  expect(f.readState().deadlines.guest).toBe(25000);
  expect(f.events).not.toContain('join:returning');
  f.service.onModuleDestroy();
});

it('suspends a resume whose Redis reply is lost after the socket is already gone', async () => {
  const logger = silenceErrors();
  const time = controlledClock();
  const f = fixture('MEETING', undefined, undefined, undefined, undefined, time.clock);
  try {
    await f.join(f.client('host'));
    const guest = f.client('guest');
    await f.join(guest);
    await f.service.disconnect(guest, f.transport);
    const next = f.client('returning', 'guest');
    const apply = vi.mocked(f.live.apply).getMockImplementation()!;
    vi.mocked(f.live.apply).mockImplementation(async (...args) => {
      if (args[2].type !== 'resume') return apply(...args);
      await apply(...args);
      await disconnectDuring(next, f.service, f.transport);
      throw new Error('reply lost');
    });
    time.set(5000);
    expect(await f.service.resume(next, resumeRequest('guest'), f.transport)).toMatchObject({
      ok: false,
      error: 'server_error',
    });
    expect(f.readState().participants.find((p) => p.participantId === 'guest')).toMatchObject({
      presence: 'suspended',
      connectionGeneration: 2,
      socketId: null,
    });
    expect(f.readState().deadlines.guest).toBe(25000);
    expect(f.events).not.toContain('join:returning');
  } finally {
    f.service.onModuleDestroy();
    logger.mockRestore();
  }
});

it('does not let a stale resume cleanup evict a newer generation', async () => {
  const time = controlledClock();
  const f = fixture('MEETING', undefined, undefined, undefined, undefined, time.clock);
  await f.join(f.client('host'));
  const guest = f.client('guest');
  await f.join(guest);
  await f.service.disconnect(guest, f.transport);
  const next = f.client('returning', 'guest');
  const apply = vi.mocked(f.live.apply).getMockImplementation()!;
  const read = vi.mocked(f.live.readParticipant).getMockImplementation()!;
  let armWinner = false;
  vi.mocked(f.live.readParticipant).mockImplementation(async (...args) => {
    if (armWinner && args[1] === 'guest') {
      armWinner = false;
      const participant = f.readState().participants.find((p) => p.participantId === 'guest');
      if (participant) {
        participant.connectionGeneration = 3;
        participant.socketId = 'newer';
        participant.presence = 'connected';
      }
      delete f.readState().deadlines.guest;
    }
    return read(...args);
  });
  vi.mocked(f.live.apply).mockImplementation(async (...args) => {
    const result = await apply(...args);
    if (args[2].type === 'resume') {
      await disconnectDuring(next, f.service, f.transport);
      armWinner = true;
    }
    return result;
  });
  expect(await f.service.resume(next, resumeRequest('guest'), f.transport)).toMatchObject({
    ok: false,
    error: 'not_joined',
  });
  expect(f.readState().participants.find((p) => p.participantId === 'guest')).toMatchObject({
    presence: 'connected',
    connectionGeneration: 3,
    socketId: 'newer',
  });
  expect(f.readState().deadlines.guest).toBeUndefined();
  expect(
    vi.mocked(f.live.apply).mock.calls.filter((call) => call[2].type === 'suspend'),
  ).toHaveLength(1);
  expect(
    await f.service.update(
      next,
      { type: 'patchMedia', participantId: 'guest', patch: { isAudioMuted: false } },
      f.transport,
    ),
  ).toMatchObject({ error: 'not_joined' });
  await f.service.sweep();
  expect(f.readState().participants.find((p) => p.participantId === 'guest')).toMatchObject({
    presence: 'connected',
    socketId: 'newer',
    connectionGeneration: 3,
  });
  f.service.onModuleDestroy();
});

it('opens the shared room view before publishing LIVE and persists after publication', async () => {
  const f = fixture('MEETING', undefined, undefined, undefined, undefined, undefined, 'SCHEDULED');
  const host = f.client('host'),
    waiter = f.client('waiter');
  await f.join(waiter);
  await f.join(host);
  expect(await f.service.scheduleCommand(waiter, 'start', f.transport)).toMatchObject({
    error: 'not_host',
  });
  expect(await f.service.scheduleCommand(host, 'start', f.transport)).toEqual({ ok: true });
  expect(waiter.room?.status).toBe('LIVE');
  expect(f.events.indexOf('database:start')).toBeGreaterThan(f.events.lastIndexOf('publish'));
  expect(f.readState().stageParticipantIds).toEqual(['host', 'waiter']);
  expect(await f.service.scheduleCommand(host, 'cancel', f.transport)).toMatchObject({
    error: 'not_scheduled',
  });
  expect(await f.service.leave(host, f.transport)).toEqual({ ok: true });
  expect(f.rooms.end).toHaveBeenCalled();
});

it('leaves scheduled memberships intact when catalog cancel fails and retries cleanup after a lost reply', async () => {
  const f = fixture('MEETING', undefined, undefined, undefined, undefined, undefined, 'SCHEDULED');
  const host = f.client('host'),
    waiter = f.client('waiter');
  await f.join(host);
  await f.join(waiter);
  const errors = silenceErrors();
  try {
    vi.mocked(f.rooms.cancelScheduled).mockRejectedValueOnce(new Error('catalog unavailable'));
    expect(await f.service.scheduleCommand(host, 'cancel', f.transport)).toMatchObject({
      error: 'server_error',
    });
    expect(f.readState().participants).toHaveLength(2);
    expect(f.live.deleteRoom).not.toHaveBeenCalled();
    vi.mocked(f.live.deleteRoom).mockRejectedValueOnce(new Error('cleanup unavailable'));
    expect(await f.service.scheduleCommand(host, 'cancel', f.transport)).toMatchObject({
      error: 'server_error',
    });
    expect(f.events.indexOf('database:cancel')).toBeLessThan(f.events.indexOf('apply:cancel'));
    expect(await f.service.scheduleCommand(host, 'cancel', f.transport)).toEqual({ ok: true });
    expect(f.live.deleteRoom).toHaveBeenCalledTimes(2);
    expect(f.transport.end).toHaveBeenCalledOnce();
  } finally {
    errors.mockRestore();
  }
});

it('drops a live admission waiter without a resume digest, deadline, or grace timer', async () => {
  const time = controlledClock();
  const f = fixture(
    'MEETING',
    undefined,
    undefined,
    undefined,
    undefined,
    time.clock,
    'LIVE',
    true,
  );
  const host = f.client('host'),
    waiter = f.client('waiter');
  try {
    await f.join(host);
    await f.join(waiter);
    expect(f.readState().participants.find((p) => p.participantId === 'waiter')?.role).toBe(
      'WAITING',
    );
    expect(f.readState().resumeDigests.waiter).toBeUndefined();
    expect(await f.service.disconnect(waiter, f.transport)).toEqual({ ok: true });
    expect(f.readState().participants).toHaveLength(1);
    expect(f.readState().deadlines.waiter).toBeUndefined();
    expect(time.clock.schedule).not.toHaveBeenCalled();
  } finally {
    f.service.onModuleDestroy();
  }
});

it('publishes waiter removal and detaches its transport without filling a seat', async () => {
  const f = fixture('MEETING', undefined, undefined, undefined, undefined, undefined, 'SCHEDULED');
  const host = f.client('host'),
    waiter = f.client('waiter');
  await f.join(host);
  await f.join(waiter);
  expect(
    await f.service.update(
      host,
      { type: 'removeWaiter', actorParticipantId: 'host', targetParticipantId: 'waiter' },
      f.transport,
    ),
  ).toEqual({ ok: true });
  expect(f.readState().stageParticipantIds).toEqual([]);
  expect(f.snapshots.at(-1)?.waitingParticipantIds).toEqual([]);
  expect(f.transport.leave).toHaveBeenCalledWith('waiter', 'room');
  expect(f.events.at(-1)).toBe('leave:waiter');
});
