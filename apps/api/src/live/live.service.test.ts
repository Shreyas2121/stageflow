import { expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { applyStageCommand, type LiveState, type RoomSnapshot } from '@stageflow/shared';
import {
  LiveService,
  type BroadcastControl,
  type LiveSession,
  type LiveTransport,
} from './live.service';
import { SerializedOperations } from './serialized-operations';
import type { LiveRepository } from './live.repository';
import type { RoomsService } from '../rooms/rooms.service';
function fixture(
  mode: LiveState['mode'] = 'MEETING',
  availability: { isReady(): boolean } = { isReady: () => true },
  namespace = 'sf',
  operations = new SerializedOperations(),
  broadcasts?: BroadcastControl,
) {
  let state: LiveState = {
    roomId: 'room',
    hostId: 'host',
    mode,
    status: 'LIVE',
    participants: [],
    stageSocketIds: [],
    hands: [],
  };
  let revision = 0;
  const events: string[] = [];
  const snapshots: RoomSnapshot[] = [];
  const sessions = new Map<string, LiveSession>();
  let catalogStatus: 'LIVE' | 'ENDED' = 'LIVE';
  const client = (id: string): LiveSession => {
    const session = { id, user: { id, displayName: id }, connected: true, room: undefined };
    sessions.set(id, session);
    return session;
  };
  const rooms: Pick<RoomsService, 'getById' | 'end'> = {
    getById: vi.fn(
      async () =>
        ({ id: 'room', hostId: 'host', mode, status: catalogStatus }) as Awaited<
          ReturnType<RoomsService['getById']>
        >,
    ),
    end: vi.fn(async () => {
      events.push('database:end');
      catalogStatus = 'ENDED';
    }),
  };
  const live: Pick<LiveRepository, 'apply' | 'readStage' | 'deleteRoom' | 'refreshSnapshot'> = {
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
    readStage: vi.fn(async () => state.stageSocketIds),
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
  const service = new LiveService(rooms, live, operations, availability, namespace, broadcasts);
  const join = (peer: LiveSession) =>
    service.join(
      peer,
      { roomId: 'room', isAudioMuted: false, isVideoOff: false, isSyntheticBot: false },
      transport,
    );
  return { service, rooms, live, transport, client, join, events, snapshots };
}
function silenceErrors() {
  return vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
}

function broadcastFixture(mode: LiveState['mode'] = 'WEBINAR') {
  let active: string | null = null;
  let broadcast: RoomSnapshot['broadcast'] = null;
  const control: BroadcastControl = {
    repository: {
      readBroadcast: vi.fn(async () => active),
      readParticipant: vi.fn(
        async (_prefix, id) =>
          f.snapshots.at(-1)?.participants.find((p) => p.socketId === id) ?? null,
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
      snapshot: vi.fn(async () => broadcast),
      start: vi.fn<BroadcastControl['service']['start']>(async (_room, _host, hooks) => {
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
  const f = fixture(mode, undefined, undefined, undefined, control);
  return { ...f, control };
}

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
  expect(after.stageSocketIds).toEqual(before.stageSocketIds);
  expect(after.participants).toEqual(before.participants);
  expect(after.broadcast).toMatchObject({ status: 'LIVE' });
  expect(await f.service.startBroadcast(host, f.transport)).toMatchObject({
    error: 'broadcast_active',
  });
  expect(f.control.service.start).toHaveBeenCalledOnce();
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
  expect(f.snapshots.at(-1)!.stageSocketIds).toEqual(before.stageSocketIds);
  expect(await f.service.startBroadcast(host, f.transport)).toEqual({ ok: true });
  f.events.length = 0;
  await f.service.leave(host, f.transport);
  expect(f.events.indexOf('broadcast:stop')).toBeLessThan(f.events.indexOf('apply:leave'));
  expect(f.events.indexOf('broadcast:stop')).toBeLessThan(f.events.indexOf('redis:delete'));
});
it('promotes a webinar attendee through only the promote repository command', async () => {
  const f = fixture('WEBINAR');
  const host = f.client('host');
  await f.join(host);
  await f.join(f.client('guest'));
  vi.mocked(f.live.apply).mockClear();
  f.snapshots.length = 0;
  const command = { type: 'promote', actorSocketId: host.id, targetSocketId: 'guest' } as const;
  expect(await f.service.update(host, command, f.transport)).toEqual({ ok: true });
  expect(f.live.apply).toHaveBeenCalledExactlyOnceWith('sf:room:room', host.room, command);
  expect(f.snapshots).toHaveLength(1);
  expect(f.snapshots[0]?.participants.find((p) => p.socketId === 'guest')?.role).toBe('SPEAKER');
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
        actorSocketId: host.id,
        targetSocketId: 'guest',
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
        actorSocketId: host.id,
        targetSocketId: host.id,
      },
      f.transport,
    ),
  ).toMatchObject({ ok: false, error: 'cannot_demote_host' });
  expect(
    await f.service.update(
      guest,
      {
        type: 'promote',
        actorSocketId: guest.id,
        targetSocketId: guest.id,
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
      actorSocketId: host.id,
      targetSocketId: 'guest',
      kind,
      locked: true,
    } as const;
    expect(await f.service.update(host, command, f.transport)).toEqual({ ok: true });
    expect(f.transport.forceMute).toHaveBeenCalledExactlyOnceWith('guest', { kind, locked: true });
    expect(f.events).toEqual(['apply:setHostLock', 'force-mute:guest', 'publish']);
    expect(f.snapshots).toHaveLength(1);
    expect(f.snapshots[0]?.participants.find((p) => p.socketId === 'guest')).toMatchObject(
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
    { type: 'patchMedia', socketId: host.id, patch: { isAudioMuted: true } },
    f.transport,
  );
  expect(f.live.apply).toHaveBeenLastCalledWith(
    'preview-blue:room:room',
    expect.anything(),
    expect.objectContaining({ type: 'patchMedia' }),
  );
  expect(await f.service.relay(host, 'guest', f.transport, vi.fn())).toEqual({ ok: true });
  expect(f.live.readStage).toHaveBeenCalledWith('preview-blue:room:room');
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
  await f.service.update(host, { type: 'patchMedia', socketId: host.id, patch: {} }, f.transport);
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
      participants: [expect.objectContaining({ socketId: 'host', role: 'HOST' })],
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
    const patch = { type: 'patchMedia', socketId: host.id, patch: { isAudioMuted: true } } as const;
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
      participants: [expect.objectContaining({ socketId: 'host', isAudioMuted: true })],
    });
    expect(f.control.service.snapshot).toHaveBeenCalledTimes(1);
    expect(f.control.repository.readBroadcast).toHaveBeenCalledTimes(1);
    expect(
      await f.service.update(
        host,
        { type: 'patchMedia', socketId: host.id, patch: { isAudioMuted: false } },
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
      expect.objectContaining({ socketId: 'late' }),
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
        stageSocketIds: [],
        hands: [],
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
    { type: 'patchMedia', socketId: guest.id, patch: { isVideoOff: true } },
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
    { type: 'patchMedia', socketId: host.id, patch: { isVideoOff: true } },
    f.transport,
  );
  await vi.waitFor(() => expect(f.live.apply).toHaveBeenCalledTimes(3));
  const burst = await Promise.all(
    Array.from({ length: 50 }, () =>
      f.service.update(guest, { type: 'patchMedia', socketId: guest.id, patch: {} }, f.transport),
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
