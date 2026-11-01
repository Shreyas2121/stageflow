import { expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { applyStageCommand, type LiveState, type RoomSnapshot } from '@stageflow/shared';
import { LiveService, type LiveSession, type LiveTransport } from './live.service';
import { SerializedOperations } from './serialized-operations';
import type { LiveRepository } from './live.repository';
import type { RoomsService } from '../rooms/rooms.service';
function fixture(mode: LiveState['mode'] = 'MEETING') {
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
  const client = (id: string): LiveSession => {
    const session = { id, user: { id, displayName: id }, connected: true, room: undefined };
    sessions.set(id, session);
    return session;
  };
  const rooms: Pick<RoomsService, 'getById' | 'end'> = {
    getById: vi.fn(
      async () =>
        ({ id: 'room', hostId: 'host', mode, status: 'LIVE' }) as Awaited<
          ReturnType<RoomsService['getById']>
        >,
    ),
    end: vi.fn(async () => {
      events.push('database:end');
    }),
  };
  const live: Pick<LiveRepository, 'apply' | 'readStage' | 'deleteRoom'> = {
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
  const service = new LiveService(rooms, live, new SerializedOperations());
  const join = (peer: LiveSession) =>
    service.join(
      peer,
      { roomId: 'room', isAudioMuted: false, isVideoOff: false, isSyntheticBot: false },
      transport,
    );
  return { service, rooms, live, transport, client, join, events, snapshots };
}
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
});
it('records the existing partial host-leave failure for C05 without changing it', async () => {
  const logger = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  try {
    const f = fixture();
    const host = f.client('host');
    await f.join(host);
    vi.mocked(f.rooms.end).mockRejectedValueOnce(new Error('database unavailable'));
    expect(await f.service.leave(host, f.transport)).toMatchObject({
      ok: false,
      error: 'server_error',
    });
    expect(f.transport.end).not.toHaveBeenCalled();
    expect(f.live.deleteRoom).not.toHaveBeenCalled();
    expect(await f.service.leave(host, f.transport)).toEqual({ ok: true });
    expect(f.rooms.end).toHaveBeenCalledTimes(1);
    expect(f.transport.end).not.toHaveBeenCalled();
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
