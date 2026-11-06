import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { io } from 'socket.io-client';
import type {
  CommandAck,
  ChatSendAck,
  ChatHistoryAck,
  ChatSetPausedAck,
  JoinAck,
  ResumeAck,
  ParticipantState,
  RoomSnapshot,
} from '@stageflow/shared';
import {
  BROADCAST_STOP_MS,
  openIndependentSignaling,
  openSignaling,
  type RoomConnection,
} from './signaling';
import { useRoomStore } from '../stores/room-store';

vi.mock('socket.io-client', () => ({ io: vi.fn() }));

class FakeSocket extends EventEmitter {
  beforeAck: () => void = () => undefined;
  constructor(readonly id: string) {
    super();
  }
  connect() {
    queueMicrotask(() => this.emit('connect'));
  }
  timeout = vi.fn((milliseconds: number) => {
    expect(milliseconds).toBeGreaterThan(0);
    return this;
  });
  disconnect = vi.fn();
  emitWithAck = vi.fn<
    (
      event: string,
      payload?: unknown,
    ) => Promise<CommandAck | JoinAck | ResumeAck | ChatSendAck | ChatHistoryAck | ChatSetPausedAck>
  >(async (event: string) => {
    if (event === 'room:join') {
      this.beforeAck();
      return { ok: true, participantId: this.id, iceServers: [] };
    }
    return { ok: true };
  });
}

const sockets: FakeSocket[] = [];
const connections: RoomConnection[] = [];
const snapshot = (roomId: string): RoomSnapshot => ({
  roomId,
  revision: 1,
  mode: 'MEETING',
  status: 'LIVE',
  participants: [],
  stageParticipantIds: [],
  waitingParticipantIds: [],
  handParticipantIds: [],
  broadcast: null,
});

const resumeRequest = { roomId: 'room', participantId: 'self', resumeCredential: 'memory-only' };
function resumeAck(revision = 10): Extract<ResumeAck, { ok: true }> {
  return {
    ok: true,
    participantId: 'self',
    connectionGeneration: 2,
    iceServers: [],
    snapshot: {
      ...snapshot('room'),
      revision,
      participants: [person('self'), person('remote')],
      stageParticipantIds: ['self', 'remote'],
      waitingParticipantIds: [],
    },
  };
}

it('uses a fresh socket to resume only, replaces the baseline, and discards the previous socket events', async () => {
  const own = callbacks();
  const old = openSignaling('token', 'room', own);
  connections.push(old);
  await old.join(joinRequest);
  const oldSocket = sockets[0]!;
  oldSocket.emit('disconnect');
  const resumed = vi.fn(() => expect(useRoomStore.getState().snapshot?.revision).toBe(10));
  const next = openSignaling('token', 'room', { ...own, onResumed: resumed });
  connections.push(next);
  sockets[1]!.emitWithAck.mockImplementationOnce(async () => {
    sockets[1]!.emit('room:state', { ...resumeAck(9).snapshot });
    sockets[1]!.emit('webrtc:description', {
      toParticipantId: 'self',
      fromParticipantId: 'remote',
      description: { type: 'offer', sdp: 'fresh' },
    });
    return resumeAck();
  });
  await next.resume(resumeRequest);
  expect(sockets[1]!.emitWithAck.mock.calls.map(([event]) => event)).toEqual(['room:resume']);
  expect(sockets[1]!.emitWithAck).toHaveBeenCalledExactlyOnceWith('room:resume', resumeRequest);
  expect(resumed).toHaveBeenCalledOnce();
  expect(own.onDescription).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ description: { type: 'offer', sdp: 'fresh' } }),
  );
  expect(resumed.mock.invocationCallOrder[0]).toBeLessThan(
    own.onDescription.mock.invocationCallOrder[0]!,
  );
  sockets[1]!.emit('room:state', resumeAck(8).snapshot);
  expect(useRoomStore.getState().snapshot?.revision).toBe(10);
  oldSocket.emit('webrtc:description', {
    toParticipantId: 'self',
    fromParticipantId: 'remote',
    description: { type: 'offer', sdp: 'stale' },
  });
  expect(own.onDescription).toHaveBeenCalledTimes(1);
  expect(
    (
      await old.description({
        toParticipantId: 'remote',
        description: { type: 'offer', sdp: 'stale' },
      })
    ).ok,
  ).toBe(false);
  expect(oldSocket.emitWithAck.mock.calls.map(([event]) => event)).toEqual(['room:join']);
  expect(vi.mocked(io).mock.calls[1]![1]).toMatchObject({ reconnection: false, forceNew: true });
});

it('applies a newer snapshot queued before the resume baseline and ignores older later revisions', async () => {
  const peer = openSignaling('token', 'room', callbacks());
  connections.push(peer);
  sockets[0]!.emitWithAck.mockImplementationOnce(async () => {
    sockets[0]!.emit('room:state', resumeAck(12).snapshot);
    return resumeAck(10);
  });
  await peer.resume(resumeRequest);
  expect(useRoomStore.getState().snapshot?.revision).toBe(12);
  sockets[0]!.emit('room:state', resumeAck(11).snapshot);
  expect(useRoomStore.getState().snapshot?.revision).toBe(12);
});

it('cancels an outstanding resume on close and sends no media or moderation before its baseline', async () => {
  const onResumed = vi.fn();
  const peer = openIndependentSignaling('token', 'room', { ...callbacks(), onResumed });
  connections.push(peer);
  let finish!: (ack: ResumeAck) => void;
  sockets[0]!.emitWithAck.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = peer.resume(resumeRequest);
  const rejected = expect(pending).rejects.toThrow('The live room connection closed.');
  for (let index = 0; index < 10; index++) await Promise.resolve();
  expect(await peer.media({ isAudioMuted: false })).toMatchObject({ error: 'not_joined' });
  expect(await peer.promote('remote')).toMatchObject({ error: 'not_joined' });
  expect(
    await peer.description({
      toParticipantId: 'remote',
      description: { type: 'offer', sdp: 'pending' },
    }),
  ).toMatchObject({ error: 'not_joined' });
  peer.close();
  finish(resumeAck());
  await rejected;
  expect(onResumed).not.toHaveBeenCalled();
  expect(sockets[0]!.emitWithAck.mock.calls.map(([event]) => event)).toEqual(['room:resume']);
});

it('does not publish the resume snapshot or queued offer if recovery is cancelled in its callback', async () => {
  const own = callbacks();
  const peer = openIndependentSignaling('token', 'room', { ...own, onResumed: () => peer.close() });
  connections.push(peer);
  sockets[0]!.emitWithAck.mockImplementationOnce(async () => {
    sockets[0]!.emit('webrtc:description', {
      toParticipantId: 'self',
      fromParticipantId: 'remote',
      description: { type: 'offer', sdp: 'cancelled' },
    });
    return resumeAck();
  });
  await peer.resume(resumeRequest);
  expect(own.onState).not.toHaveBeenCalled();
  expect(own.onDescription).not.toHaveBeenCalled();
});
function person(participantId: string): ParticipantState {
  return {
    participantId,
    socketId: `transport-${participantId}`,
    connectionGeneration: 1,
    presence: 'connected',
    userId: participantId,
    displayName: participantId,
    role: 'SPEAKER',
    isAudioMuted: false,
    isVideoOff: false,
    isScreenSharing: false,
    isHandRaised: false,
    isSyntheticBot: false,
    hostAudioLocked: false,
    hostVideoLocked: false,
    joinedAt: 1,
  };
}
const joinRequest = {
  roomId: 'room',
  isAudioMuted: false,
  isVideoOff: false,
  isSyntheticBot: false,
};

it('stores the acknowledged participant id independently of the signaling socket id', async () => {
  const connection = openSignaling('token', 'room', callbacks());
  connections.push(connection);
  sockets[0]!.emitWithAck.mockResolvedValueOnce({
    ok: true,
    participantId: 'membership',
    iceServers: [],
  });
  expect(await connection.join(joinRequest)).toMatchObject({ participantId: 'membership' });
  expect(useRoomStore.getState().selfParticipantId).toBe('membership');
  expect(sockets[0]!.id).toBe('socket-0');
});
function callbacks() {
  return {
    onChatMessage: vi.fn(),
    onChatPaused: vi.fn(),
    onEnded: vi.fn(),
    onDisconnect: vi.fn(),
    onDescription: vi.fn(),
    onCandidate: vi.fn(),
    onState: vi.fn(),
    onJoined: vi.fn(),
  };
}

beforeEach(() => {
  vi.stubEnv('VITE_WS_URL', 'http://localhost:4000');
  sockets.length = 0;
  useRoomStore.getState().clear();
  vi.mocked(io).mockImplementation(() => {
    const socket = new FakeSocket(`socket-${sockets.length}`);
    sockets.push(socket);
    return socket as unknown as ReturnType<typeof io>;
  });
});
afterEach(() => {
  for (const connection of connections.splice(0)) connection.close();
  vi.unstubAllEnvs();
});

describe('signaling connection ownership', () => {
  it('gates chat commands on membership and isolates early chat from stage signaling', async () => {
    const own = callbacks();
    const peer = openIndependentSignaling('token', 'room', own);
    connections.push(peer);
    const request = { requestId: 'request', text: 'hello' };
    expect(await peer.chatSend(request)).toMatchObject({ error: 'not_joined' });
    expect(await peer.chatHistory({})).toMatchObject({ error: 'not_joined' });
    expect(await peer.chatSetPaused({ paused: true })).toMatchObject({ error: 'not_joined' });
    const message = {
      sequence: 1,
      participantId: 'self',
      displayName: 'Ava',
      role: 'HOST' as const,
      text: 'hello',
      sentAt: 0,
    };
    sockets[0]!.beforeAck = () => {
      for (let index = 0; index < 100; index++) sockets[0]!.emit('chat:message', message);
      sockets[0]!.emit('chat:paused', { paused: true });
    };
    expect((await peer.join(joinRequest)).ok).toBe(true);
    expect(own.onChatMessage).not.toHaveBeenCalled();
    sockets[0]!.emit('chat:message', message);
    sockets[0]!.emit('chat:paused', { paused: false });
    expect(own.onChatMessage).toHaveBeenCalledExactlyOnceWith(message);
    expect(own.onChatPaused).toHaveBeenCalledExactlyOnceWith(false);
    sockets[0]!.emitWithAck.mockResolvedValueOnce({ ok: true, message });
    expect(await peer.chatSend(request)).toEqual({ ok: true, message });
    sockets[0]!.emitWithAck.mockResolvedValueOnce({ ok: true, paused: true });
    expect(await peer.chatSetPaused({ paused: true })).toEqual({ ok: true, paused: true });
    await peer.chatHistory({ beforeSequence: 4, limit: 100 });
    expect(sockets[0]!.emitWithAck.mock.calls.map(([event]) => event)).toEqual([
      'room:join',
      'chat:send',
      'chat:set-paused',
      'chat:history',
    ]);
    sockets[0]!.emit('disconnect');
    sockets[0]!.emit('chat:message', message);
    expect(own.onChatMessage).toHaveBeenCalledOnce();
    expect(await peer.chatSend(request)).toMatchObject({ error: 'not_joined' });
  });
  it('allows the server stop deadline to complete after the ordinary eight-second ack budget', async () => {
    vi.useFakeTimers();
    try {
      const connection = openIndependentSignaling('token', 'room', callbacks());
      connections.push(connection);
      await connection.join(joinRequest);
      sockets[0]!.emitWithAck.mockImplementationOnce(
        () => new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 10_000)),
      );
      const stopping = connection.stopBroadcast();
      await vi.advanceTimersByTimeAsync(8_000);
      expect(sockets[0]!.timeout).toHaveBeenCalledWith(BROADCAST_STOP_MS);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(await stopping).toEqual({ ok: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['READY', 'FAILED', 'LIVE', 'STOPPING'] as const)(
    'reconciles a lost stop acknowledgement with %s for the same attempt',
    async (status) => {
      const connection = openIndependentSignaling('token', 'room', callbacks());
      connections.push(connection);
      await connection.join(joinRequest);
      const socket = sockets[0]!;
      socket.emit('room:state', {
        ...snapshot('room'),
        broadcast: { id: 'cast', status: 'LIVE', playlistUrl: null, errorMessage: null },
      });
      socket.emitWithAck.mockImplementationOnce(async () => {
        socket.emit('room:state', {
          ...snapshot('room'),
          revision: 2,
          broadcast: { id: 'cast', status, playlistUrl: null, errorMessage: 'producer lost' },
        });
        throw new Error('ack lost');
      });
      const result = await connection.stopBroadcast();
      expect(result.ok).toBe(status === 'READY');
      if (!result.ok)
        expect(result.message).toBe(
          status === 'FAILED'
            ? 'producer lost'
            : 'Broadcast stop is not confirmed. Check its status before trying again.',
        );
    },
  );

  it('does not treat a newer attempt as confirmation of an older stop', async () => {
    const connection = openIndependentSignaling('token', 'room', callbacks());
    connections.push(connection);
    await connection.join(joinRequest);
    const socket = sockets[0]!;
    socket.emit('room:state', {
      ...snapshot('room'),
      broadcast: { id: 'old', status: 'LIVE', playlistUrl: null, errorMessage: null },
    });
    socket.emitWithAck.mockImplementationOnce(async () => {
      socket.emit('room:state', {
        ...snapshot('room'),
        revision: 2,
        broadcast: { id: 'new', status: 'READY', playlistUrl: null, errorMessage: null },
      });
      throw new Error('ack lost');
    });
    expect(await connection.stopBroadcast()).toMatchObject({ ok: false });
  });

  it('keeps an independent socket and its snapshots outside the host store', async () => {
    const host = openSignaling('host-token', 'room', callbacks());
    connections.push(host);
    await host.join(joinRequest);
    sockets[0]!.emit('room:state', snapshot('room'));
    const hostState = useRoomStore.getState();
    const own = callbacks();
    const demo = openIndependentSignaling('demo-token', 'room', own);
    connections.push(demo);
    sockets[1]!.beforeAck = () => sockets[1]!.emit('room:state', snapshot('room'));
    await demo.join({ ...joinRequest, isSyntheticBot: true });
    expect(own.onState).toHaveBeenCalledWith(snapshot('room'));
    expect(own.onJoined).toHaveBeenCalledWith({
      ok: true,
      participantId: 'socket-1',
      iceServers: [],
    });
    expect(useRoomStore.getState()).toBe(hostState);
    expect(sockets[1]!.emitWithAck.mock.calls.map(([event]) => event)).toEqual(['room:join']);
    expect(sockets[0]!.disconnect).not.toHaveBeenCalled();
    demo.close();
    demo.close();
    expect(sockets[1]!.disconnect).toHaveBeenCalledOnce();
    expect(useRoomStore.getState()).toBe(hostState);
    expect(useRoomStore.getState().selfParticipantId).toBe('socket-0');
    expect(io).toHaveBeenLastCalledWith(
      'http://localhost:4000',
      expect.objectContaining({
        auth: { token: 'demo-token' },
        forceNew: true,
        reconnection: false,
      }),
    );
  });

  it('still replaces the previous host connection and writes/clears the host store', async () => {
    const first = openSignaling('first', 'room', callbacks());
    connections.push(first);
    await first.join(joinRequest);
    expect(useRoomStore.getState().selfParticipantId).toBe('socket-0');
    const next = openSignaling('next', 'next-room', callbacks());
    connections.push(next);
    expect(sockets[0]!.disconnect).toHaveBeenCalledOnce();
    expect(useRoomStore.getState().roomId).toBe('next-room');
    expect(useRoomStore.getState().selfParticipantId).toBeNull();
    next.close();
    expect(useRoomStore.getState().roomId).toBeNull();
  });

  it('sends human moderation commands on its own socket without changing either snapshot', async () => {
    const host = openSignaling('host-token', 'room', callbacks());
    connections.push(host);
    await host.join(joinRequest);
    sockets[0]!.emit('room:state', snapshot('room'));
    const hostState = useRoomStore.getState();
    const own = callbacks();
    const demo = openIndependentSignaling('demo-token', 'room', own);
    connections.push(demo);
    await demo.join({ ...joinRequest, isSyntheticBot: true });
    await expect(host.promote('guest')).resolves.toEqual({ ok: true });
    await expect(host.demote('guest')).resolves.toEqual({ ok: true });
    await expect(host.startBroadcast()).resolves.toEqual({ ok: true });
    await expect(host.stopBroadcast()).resolves.toEqual({ ok: true });
    await expect(
      host.setLock({ targetParticipantId: 'guest', kind: 'audio', locked: true }),
    ).resolves.toEqual({ ok: true });
    expect(sockets[0]!.emitWithAck.mock.calls).toEqual([
      ['room:join', joinRequest],
      ['stage:promote', { targetParticipantId: 'guest' }],
      ['stage:demote', { targetParticipantId: 'guest' }],
      ['broadcast:start'],
      ['broadcast:stop'],
      ['stage:set-lock', { targetParticipantId: 'guest', kind: 'audio', locked: true }],
    ]);
    expect(sockets[1]!.emitWithAck.mock.calls).toEqual([
      ['room:join', { ...joinRequest, isSyntheticBot: true }],
    ]);
    sockets[1]!.emit('room:state', { ...snapshot('room'), revision: 2 });
    expect(own.onState).toHaveBeenCalledWith({ ...snapshot('room'), revision: 2 });
    expect(useRoomStore.getState()).toBe(hostState);
  });

  it('delivers early descriptions and candidates after the peer join callback', async () => {
    const own = callbacks();
    const delivery: string[] = [];
    own.onJoined.mockImplementation(() => {
      delivery.push('joined');
    });
    own.onDescription.mockImplementation(() => {
      delivery.push('description');
    });
    own.onCandidate.mockImplementation(() => {
      delivery.push('candidate');
    });
    const peer = openIndependentSignaling('token', 'room', own);
    connections.push(peer);
    sockets[0]!.beforeAck = () => {
      sockets[0]!.emit('room:state', {
        ...snapshot('room'),
        stageParticipantIds: ['socket-0', 'other'],
        waitingParticipantIds: [],
        participants: [person('socket-0'), person('other')],
      });
      sockets[0]!.emit('webrtc:description', {
        toParticipantId: 'socket-0',
        fromParticipantId: 'other',
        description: { type: 'offer', sdp: 'test' },
      });
      sockets[0]!.emit('webrtc:ice-candidate', {
        toParticipantId: 'socket-0',
        fromParticipantId: 'other',
        candidate: null,
      });
    };
    await peer.join(joinRequest);
    expect(delivery).toEqual(['joined', 'description', 'candidate']);
    sockets[0]!.emit('room:state', snapshot('other-room'));
    sockets[0]!.emit('room:ended', { roomId: 'other-room' });
    expect(own.onState).toHaveBeenCalledTimes(1);
    expect(own.onEnded).not.toHaveBeenCalled();
    sockets[0]!.emit('room:ended', { roomId: 'room' });
    expect(own.onEnded).toHaveBeenCalledOnce();
    expect(sockets[0]!.disconnect).toHaveBeenCalledOnce();
  });

  it('rejects the join and drops queued events when pre-join signaling overflows', async () => {
    const own = callbacks();
    const peer = openIndependentSignaling('token', 'room', own);
    connections.push(peer);
    sockets[0]!.beforeAck = () => {
      for (let index = 0; index < 33; index += 1) {
        sockets[0]!.emit('webrtc:ice-candidate', { candidate: null });
      }
    };
    await expect(peer.join(joinRequest)).rejects.toThrow('Live signaling overflowed before join.');
    expect(own.onCandidate).not.toHaveBeenCalled();
    expect(own.onJoined).not.toHaveBeenCalled();
  });

  it('does not replay an off-stage description or candidate after a later stage gain', async () => {
    const own = { ...callbacks(), onForceMute: vi.fn() };
    const peer = openIndependentSignaling('token', 'room', own);
    connections.push(peer);
    sockets[0]!.beforeAck = () => {
      sockets[0]!.emit('room:state', snapshot('room'));
      sockets[0]!.emit('webrtc:description', {
        toParticipantId: 'socket-0',
        fromParticipantId: 'host',
        description: { type: 'offer', sdp: 'old' },
      });
      sockets[0]!.emit('webrtc:ice-candidate', {
        toParticipantId: 'socket-0',
        fromParticipantId: 'host',
        candidate: null,
      });
      sockets[0]!.emit('room:state', {
        ...snapshot('room'),
        revision: 2,
        stageParticipantIds: ['socket-0', 'host'],
        waitingParticipantIds: [],
        participants: [person('socket-0'), person('host')],
      });
    };
    await peer.join(joinRequest);
    expect(own.onDescription).not.toHaveBeenCalled();
    expect(own.onCandidate).not.toHaveBeenCalled();
    sockets[0]!.emit('stage:force-mute', { kind: 'video', locked: true });
    expect(own.onForceMute).toHaveBeenCalledExactlyOnceWith({ kind: 'video', locked: true });
    peer.close();
    sockets[0]!.emit('stage:force-mute', { kind: 'audio', locked: true });
    expect(own.onForceMute).toHaveBeenCalledTimes(1);
  });

  it('rejects the join when one pre-join event exceeds the byte budget', async () => {
    const own = callbacks();
    const peer = openIndependentSignaling('token', 'room', own);
    connections.push(peer);
    sockets[0]!.beforeAck = () => {
      sockets[0]!.emit('webrtc:description', {
        description: { type: 'offer', sdp: 'x'.repeat(300_000) },
      });
    };
    await expect(peer.join(joinRequest)).rejects.toThrow('Live signaling overflowed before join.');
    expect(own.onDescription).not.toHaveBeenCalled();
  });

  it('rejects the join when pre-join signaling expires', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const own = callbacks();
      const peer = openIndependentSignaling('token', 'room', own);
      connections.push(peer);
      sockets[0]!.emitWithAck = vi.fn((event: string) => {
        if (event === 'room:join') {
          sockets[0]!.emit('webrtc:ice-candidate', { candidate: null });
          return new Promise(() => undefined);
        }
        return Promise.resolve({ ok: true });
      });
      const joining = peer.join(joinRequest);
      const expired = expect(joining).rejects.toThrow('Live signaling expired before join.');
      for (let step = 0; step < 10; step += 1) await Promise.resolve();
      expect(sockets[0]!.emitWithAck).toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(8_000);
      await expired;
      expect(own.onCandidate).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not deliver events after close, including ones queued before the join ack', async () => {
    const own = callbacks();
    const peer = openIndependentSignaling('token', 'room', own);
    connections.push(peer);
    let finish: (ack: { ok: true; participantId: string; iceServers: [] }) => void = () =>
      undefined;
    sockets[0]!.emitWithAck = vi.fn((event: string) => {
      if (event === 'room:join') {
        sockets[0]!.emit('webrtc:ice-candidate', { candidate: null });
        return new Promise((resolve) => {
          finish = resolve;
        });
      }
      return Promise.resolve({ ok: true });
    });
    const joining = peer.join(joinRequest);
    for (let step = 0; step < 10; step += 1) await Promise.resolve();
    peer.close();
    finish({ ok: true, participantId: 'socket-0', iceServers: [] });
    await joining;
    expect(own.onCandidate).not.toHaveBeenCalled();
    expect(own.onJoined).not.toHaveBeenCalled();
    sockets[0]!.emit('webrtc:ice-candidate', { candidate: null });
    sockets[0]!.emit('webrtc:description', { description: { type: 'offer', sdp: 'late' } });
    expect(own.onCandidate).not.toHaveBeenCalled();
    expect(own.onDescription).not.toHaveBeenCalled();
  });
});
