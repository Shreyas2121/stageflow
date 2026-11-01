import { afterEach, beforeEach, describe, expect, it, vi, type Mocked } from 'vitest';
import { createGuest } from '../api';
import { PeerManager } from './peer-manager';
import { openIndependentSignaling, type RoomConnection } from './signaling';
import { DemoPeer } from './demo-peer';

vi.mock('../api', () => ({ createGuest: vi.fn() }));
vi.mock('./signaling', () => ({ openIndependentSignaling: vi.fn() }));
vi.mock('./peer-manager', () => ({
  PeerManager: vi.fn(
    class {
      sync = vi.fn();
      close = vi.fn();
      description = vi.fn();
      candidate = vi.fn();
    },
  ),
}));

function track() {
  return { stop: vi.fn() };
}
let video: ReturnType<typeof track>;
let audio: ReturnType<typeof track>;
let context: AudioContext;
let closeContext: ReturnType<typeof vi.fn>;
let stopOscillator: ReturnType<typeof vi.fn>;
let gainFailure: boolean;
let connection: Mocked<RoomConnection>;

beforeEach(() => {
  vi.clearAllMocks();
  gainFailure = false;
  video = track();
  audio = track();
  closeContext = vi.fn(async () => undefined);
  stopOscillator = vi.fn();
  context = {
    state: 'running',
    currentTime: 0,
    close: closeContext,
    createMediaStreamDestination: () => ({ stream: { getAudioTracks: () => [audio] } }),
    createOscillator: () => ({
      frequency: { value: 0 },
      connect: vi.fn(),
      start: vi.fn(),
      stop: stopOscillator,
      disconnect: vi.fn(),
    }),
    createGain: () => {
      if (gainFailure) throw new Error('Audio setup failed');
      return { gain: { value: 0 }, connect: vi.fn(), disconnect: vi.fn() };
    },
  } as unknown as AudioContext;
  vi.stubGlobal('document', {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({}),
      captureStream: () => ({ getVideoTracks: () => [video] }),
    }),
  });
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn(() => 7),
  );
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.mocked(createGuest).mockResolvedValue({
    token: 'demo-token',
    userId: 'demo-user',
    displayName: 'Demo Peer 1',
  });
  connection = {
    join: vi.fn(async () => ({ ok: true as const, selfSocketId: 'demo', iceServers: [] })),
    leave: vi.fn(async () => ({ ok: true as const })),
    close: vi.fn(),
    description: vi.fn(async () => ({ ok: true as const })),
    candidate: vi.fn(async () => ({ ok: true as const })),
    media: vi.fn(async () => ({ ok: true as const })),
    hand: vi.fn(async () => ({ ok: true as const })),
  };
  vi.mocked(openIndependentSignaling).mockReturnValue(connection);
});
afterEach(() => vi.unstubAllGlobals());

describe('DemoPeer cleanup', () => {
  it('joins as synthetic, syncs from its own snapshot and ack, and stops once', async () => {
    const stopped = vi.fn();
    const peer = new DemoPeer('Demo Peer 1', context, vi.fn(), stopped);
    await peer.start('room');
    expect(connection.join).toHaveBeenCalledWith({
      roomId: 'room',
      isAudioMuted: false,
      isVideoOff: false,
      isSyntheticBot: true,
    });
    expect(peer.microphoneTrack()).toBe(audio);
    expect(peer.cameraTrack()).toBe(video);
    expect(peer.screenTrack()).toBeNull();
    const callbacks = vi.mocked(openIndependentSignaling).mock.calls[0]![2];
    callbacks.onJoined({ ok: true, selfSocketId: 'demo', iceServers: [] });
    callbacks.onState({
      roomId: 'room',
      revision: 1,
      mode: 'WEBINAR',
      status: 'LIVE',
      participants: [],
      stageSocketIds: ['host'],
      handSocketIds: [],
      broadcast: null,
    });
    expect(vi.mocked(PeerManager).mock.results[0]!.value.sync).toHaveBeenCalledWith(
      'demo',
      ['host'],
      [],
    );
    peer.stop();
    peer.stop();
    expect(connection.leave).toHaveBeenCalledOnce();
    expect(connection.close).toHaveBeenCalledOnce();
    expect(audio.stop).toHaveBeenCalledOnce();
    expect(video.stop).toHaveBeenCalledOnce();
    expect(stopOscillator).toHaveBeenCalledOnce();
    expect(closeContext).toHaveBeenCalledOnce();
    expect(cancelAnimationFrame).toHaveBeenCalledWith(7);
    expect(stopped).toHaveBeenCalledOnce();
  });

  it('cleans media and signaling on a rejected join', async () => {
    connection.join.mockResolvedValue({
      ok: false,
      error: 'stage_full',
      message: 'The stage is full.',
    });
    const peer = new DemoPeer('Demo Peer 1', context);
    await expect(peer.start('room')).rejects.toThrow('The stage is full.');
    expect(connection.close).toHaveBeenCalledOnce();
    expect(audio.stop).toHaveBeenCalledOnce();
    expect(video.stop).toHaveBeenCalledOnce();
    expect(closeContext).toHaveBeenCalledOnce();
  });

  it('does not open a socket when stopped during guest creation', async () => {
    let finish!: (value: Awaited<ReturnType<typeof createGuest>>) => void;
    vi.mocked(createGuest).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const peer = new DemoPeer('Demo Peer 1', context);
    const start = peer.start('room');
    peer.stop();
    finish({ token: 'token', userId: 'user', displayName: 'Demo Peer 1' });
    await expect(start).rejects.toThrow('cancelled');
    expect(openIndependentSignaling).not.toHaveBeenCalled();
    expect(audio.stop).toHaveBeenCalledOnce();
    expect(video.stop).toHaveBeenCalledOnce();
    expect(closeContext).toHaveBeenCalledOnce();
  });

  it('releases a partially built media source before the oscillator starts', async () => {
    gainFailure = true;
    const peer = new DemoPeer('Demo Peer 1', context);
    await expect(peer.start('room')).rejects.toThrow('Audio setup failed');
    expect(stopOscillator).not.toHaveBeenCalled();
    expect(audio.stop).toHaveBeenCalledOnce();
    expect(video.stop).toHaveBeenCalledOnce();
    expect(closeContext).toHaveBeenCalledOnce();
  });
});
