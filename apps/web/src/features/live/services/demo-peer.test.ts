import { afterEach, beforeEach, describe, expect, it, vi, type Mocked } from 'vitest';
import { createGuest } from '../../session/api';
import { PeerManager } from './peer-manager';
import { openIndependentSignaling, type RoomConnection } from './signaling';
import { DemoPeer } from './demo-peer';
import type { ParticipantState, RoomSnapshot } from '@stageflow/shared';

vi.mock('../../session/api', () => ({ createGuest: vi.fn() }));
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
  return { enabled: true, stop: vi.fn() };
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
    chatHistory: vi.fn(),
    chatSend: vi.fn(),
    chatSetPaused: vi.fn(),
    resume: vi.fn(),
    join: vi.fn(async () => ({ ok: true as const, participantId: 'demo', iceServers: [] })),
    leave: vi.fn(async () => ({ ok: true as const })),
    close: vi.fn(),
    description: vi.fn(async () => ({ ok: true as const })),
    candidate: vi.fn(async () => ({ ok: true as const })),
    media: vi.fn(async () => ({ ok: true as const })),
    hand: vi.fn(async () => ({ ok: true as const })),
    promote: vi.fn(async () => ({ ok: true as const })),
    demote: vi.fn(async () => ({ ok: true as const })),
    setLock: vi.fn(async () => ({ ok: true as const })),
    startBroadcast: vi.fn(async () => ({ ok: true as const })),
    stopBroadcast: vi.fn(async () => ({ ok: true as const })),
  };
  vi.mocked(openIndependentSignaling).mockReturnValue(connection);
});
afterEach(() => vi.unstubAllGlobals());

describe('DemoPeer cleanup', () => {
  it('opens no connection as attendee, syncs and activates once on promotion, and disposes on demotion', async () => {
    const actual = await vi.importActual<typeof import('./peer-manager')>('./peer-manager');
    vi.mocked(PeerManager).mockImplementationOnce(actual.PeerManager);
    const pcs: { close: ReturnType<typeof vi.fn> }[] = [];
    vi.stubGlobal(
      'RTCPeerConnection',
      class {
        close = vi.fn();
        private transceivers: { sender: { track: MediaStreamTrack } }[] = [];
        addTrack = vi.fn((track: MediaStreamTrack) => {
          const sender = { track };
          this.transceivers.push({ sender });
          return sender;
        });
        getTransceivers = () => this.transceivers;
        constructor() {
          pcs.push(this);
        }
      },
    );
    vi.stubGlobal('MediaStream', class {});
    const error = vi.fn();
    const peer = new DemoPeer('Demo Peer 1', context, error);
    await peer.start('room');
    const callbacks = vi.mocked(openIndependentSignaling).mock.calls[0]![2];
    callbacks.onJoined({ ok: true, participantId: 'demo', iceServers: [] });
    const self: ParticipantState = {
      participantId: 'demo',
      socketId: 'socket-demo',
      connectionGeneration: 1,
      presence: 'connected',
      userId: 'demo-user',
      displayName: 'Demo Peer 1',
      role: 'ATTENDEE',
      isAudioMuted: true,
      isVideoOff: true,
      isScreenSharing: false,
      isHandRaised: false,
      isSyntheticBot: true,
      hostAudioLocked: false,
      hostVideoLocked: false,
      joinedAt: 1,
    };
    const host: ParticipantState = {
      ...self,
      participantId: 'host',
      socketId: 'socket-host',
      role: 'HOST',
    };
    const attendee: RoomSnapshot = {
      roomId: 'room',
      revision: 1,
      mode: 'WEBINAR',
      status: 'LIVE',
      participants: [self, host],
      stageParticipantIds: ['host'],
      handParticipantIds: [],
      broadcast: null,
    };
    callbacks.onState(attendee);
    expect(pcs).toHaveLength(0);
    expect(connection.media).not.toHaveBeenCalled();
    expect(audio.enabled).toBe(false);
    const promoted: RoomSnapshot = {
      ...attendee,
      revision: 2,
      participants: [{ ...self, role: 'SPEAKER' }, host],
      stageParticipantIds: ['demo', 'host'],
    };
    callbacks.onState(promoted);
    expect(pcs).toHaveLength(1);
    expect(connection.media).toHaveBeenCalledExactlyOnceWith({
      isAudioMuted: false,
      isVideoOff: false,
    });
    expect(audio.enabled).toBe(false);
    const active = {
      ...promoted,
      revision: 3,
      participants: [
        { ...promoted.participants[0]!, isAudioMuted: false, isVideoOff: false },
        host,
      ],
    };
    callbacks.onState(active);
    expect(audio.enabled).toBe(true);
    expect(video.enabled).toBe(true);
    expect(connection.media).toHaveBeenCalledTimes(1);
    callbacks.onForceMute?.({ kind: 'audio', locked: true });
    expect(audio.enabled).toBe(false);
    callbacks.onForceMute?.({ kind: 'audio', locked: false });
    expect(audio.enabled).toBe(false);
    callbacks.onState({
      ...active,
      revision: 4,
      participants: [{ ...active.participants[0]!, hostVideoLocked: true }],
    });
    expect(audio.enabled).toBe(true);
    expect(video.enabled).toBe(false);
    callbacks.onState({ ...attendee, revision: 5 });
    expect(pcs[0]!.close).toHaveBeenCalledOnce();
    expect(audio.enabled).toBe(false);
    expect(video.enabled).toBe(false);
    expect(connection.close).not.toHaveBeenCalled();
    expect(connection.promote).not.toHaveBeenCalled();
    expect(connection.demote).not.toHaveBeenCalled();
    expect(connection.setLock).not.toHaveBeenCalled();
    peer.stop();
  });

  it('reports a rejected activation and does not invent unmuted demo tracks', async () => {
    connection.media.mockResolvedValue({
      ok: false,
      error: 'audio_locked',
      message: 'The host has muted your microphone.',
    });
    const error = vi.fn();
    const peer = new DemoPeer('Demo Peer 1', context, error);
    await peer.start('room');
    const callbacks = vi.mocked(openIndependentSignaling).mock.calls[0]![2];
    callbacks.onJoined({ ok: true, participantId: 'demo', iceServers: [] });
    callbacks.onState({
      roomId: 'room',
      revision: 1,
      mode: 'WEBINAR',
      status: 'LIVE',
      participants: [],
      stageParticipantIds: ['demo', 'host'],
      handParticipantIds: [],
      broadcast: null,
    });
    await vi.waitFor(() =>
      expect(error).toHaveBeenCalledWith('The host has muted your microphone.'),
    );
    expect(audio.enabled).toBe(false);
    expect(video.enabled).toBe(false);
    peer.stop();
  });
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
    callbacks.onJoined({ ok: true, participantId: 'demo', iceServers: [] });
    callbacks.onState({
      roomId: 'room',
      revision: 1,
      mode: 'WEBINAR',
      status: 'LIVE',
      participants: [],
      stageParticipantIds: ['host'],
      handParticipantIds: [],
      broadcast: null,
    });
    expect(vi.mocked(PeerManager).mock.results[0]!.value.sync).toHaveBeenCalledWith('demo', [], []);
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
    const signal = vi.mocked(createGuest).mock.calls.at(-1)?.[1];
    peer.stop();
    expect(signal?.aborted).toBe(true);
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
