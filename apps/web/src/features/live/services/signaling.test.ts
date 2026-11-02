import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { io } from 'socket.io-client';
import type { RoomSnapshot } from '@stageflow/shared';
import { openIndependentSignaling, openSignaling, type RoomConnection } from './signaling';
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
  timeout() {
    return this;
  }
  disconnect = vi.fn();
  emitWithAck = vi.fn(async (event: string) => {
    if (event === 'room:join') {
      this.beforeAck();
      return { ok: true, selfSocketId: this.id, iceServers: [] };
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
  stageSocketIds: [],
  handSocketIds: [],
  broadcast: null,
});
const joinRequest = {
  roomId: 'room',
  isAudioMuted: false,
  isVideoOff: false,
  isSyntheticBot: false,
};
function callbacks() {
  return {
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
      selfSocketId: 'socket-1',
      iceServers: [],
    });
    expect(useRoomStore.getState()).toBe(hostState);
    expect(sockets[1]!.emitWithAck.mock.calls.map(([event]) => event)).toEqual(['room:join']);
    expect(sockets[0]!.disconnect).not.toHaveBeenCalled();
    demo.close();
    demo.close();
    expect(sockets[1]!.disconnect).toHaveBeenCalledOnce();
    expect(useRoomStore.getState()).toBe(hostState);
    expect(useRoomStore.getState().selfSocketId).toBe('socket-0');
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
    expect(useRoomStore.getState().selfSocketId).toBe('socket-0');
    const next = openSignaling('next', 'next-room', callbacks());
    connections.push(next);
    expect(sockets[0]!.disconnect).toHaveBeenCalledOnce();
    expect(useRoomStore.getState().roomId).toBe('next-room');
    expect(useRoomStore.getState().selfSocketId).toBeNull();
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
    await expect(
      host.setLock({ targetSocketId: 'guest', kind: 'audio', locked: true }),
    ).resolves.toEqual({ ok: true });
    expect(sockets[0]!.emitWithAck.mock.calls).toEqual([
      ['room:join', joinRequest],
      ['stage:promote', { targetSocketId: 'guest' }],
      ['stage:demote', { targetSocketId: 'guest' }],
      ['stage:set-lock', { targetSocketId: 'guest', kind: 'audio', locked: true }],
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
        stageSocketIds: ['socket-0', 'other'],
      });
      sockets[0]!.emit('webrtc:description', {
        toSocketId: 'socket-0',
        fromSocketId: 'other',
        description: { type: 'offer', sdp: 'test' },
      });
      sockets[0]!.emit('webrtc:ice-candidate', {
        toSocketId: 'socket-0',
        fromSocketId: 'other',
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
        toSocketId: 'socket-0',
        fromSocketId: 'host',
        description: { type: 'offer', sdp: 'old' },
      });
      sockets[0]!.emit('webrtc:ice-candidate', {
        toSocketId: 'socket-0',
        fromSocketId: 'host',
        candidate: null,
      });
      sockets[0]!.emit('room:state', {
        ...snapshot('room'),
        revision: 2,
        stageSocketIds: ['socket-0', 'host'],
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
    let finish: (ack: { ok: true; selfSocketId: string; iceServers: [] }) => void = () => undefined;
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
    finish({ ok: true, selfSocketId: 'socket-0', iceServers: [] });
    await joining;
    expect(own.onCandidate).not.toHaveBeenCalled();
    expect(own.onJoined).not.toHaveBeenCalled();
    sockets[0]!.emit('webrtc:ice-candidate', { candidate: null });
    sockets[0]!.emit('webrtc:description', { description: { type: 'offer', sdp: 'late' } });
    expect(own.onCandidate).not.toHaveBeenCalled();
    expect(own.onDescription).not.toHaveBeenCalled();
  });
});
