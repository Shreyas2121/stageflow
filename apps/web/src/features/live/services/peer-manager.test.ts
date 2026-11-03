import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandAck, StageIceCandidate } from '@stageflow/shared';
import type { LocalMedia } from './local-media';
import type { RoomConnection } from './signaling';
import { PeerManager } from './peer-manager';

function track(kind: 'audio' | 'video'): MediaStreamTrack {
  return { kind, enabled: true, readyState: 'live' } as MediaStreamTrack;
}
class Stream {
  constructor(private tracks: MediaStreamTrack[] = []) {}
  getTracks() {
    return this.tracks;
  }
  addTrack(track: MediaStreamTrack) {
    this.tracks.push(track);
  }
  removeTrack(track: MediaStreamTrack) {
    this.tracks = this.tracks.filter((t) => t !== track);
  }
}
const connections: FakeConnection[] = [];
function senderFor(track: MediaStreamTrack) {
  const sender = {
    track,
    replaceTrack: vi.fn(async (next: MediaStreamTrack) => {
      sender.track = next;
    }),
  };
  return sender;
}
type Transceiver = { sender: ReturnType<typeof senderFor>; receiver: { track: { kind: string } } };
class FakeConnection {
  signalingState = 'stable';
  connectionState = 'new';
  remoteDescription: RTCSessionDescriptionInit | null = null;
  localDescription: RTCSessionDescriptionInit | null = null;
  onnegotiationneeded: (() => void) | null = null;
  ontrack: ((event: { track: MediaStreamTrack }) => void) | null = null;
  transceivers: Transceiver[] = [];
  constructor() {
    connections.push(this);
  }
  addTrack = vi.fn((mediaTrack: MediaStreamTrack): Transceiver => {
    const transceiver = {
      sender: senderFor(mediaTrack),
      receiver: { track: { kind: mediaTrack.kind } },
    };
    this.transceivers.push(transceiver);
    return transceiver;
  });
  addTransceiver = vi.fn((kind: string): Transceiver => {
    const mediaTrack = track(kind === 'audio' ? 'audio' : 'video');
    const transceiver = { sender: senderFor(mediaTrack), receiver: { track: { kind } } };
    this.transceivers.push(transceiver);
    return transceiver;
  });
  getTransceivers() {
    return this.transceivers;
  }
  setLocalDescription = vi.fn(async () => {
    const type = this.remoteDescription?.type === 'offer' ? 'answer' : 'offer';
    this.localDescription = { type, sdp: 'test' };
    this.signalingState = type === 'offer' ? 'have-local-offer' : 'stable';
  });
  setRemoteDescription = vi.fn(async (description: RTCSessionDescriptionInit) => {
    this.remoteDescription = description;
    this.signalingState = description.type === 'offer' ? 'have-remote-offer' : 'stable';
  });
  close() {
    this.connectionState = 'closed';
  }
  addIceCandidate = vi.fn<(candidate?: RTCIceCandidateInit | null) => Promise<void>>(
    async () => undefined,
  );
}
const camera = track('video');
const microphone = track('audio');
let screen: MediaStreamTrack | null;
let manager: PeerManager;
let signaling: RoomConnection;
const errors: string[] = [];

beforeEach(() => {
  connections.length = 0;
  errors.length = 0;
  screen = null;
  vi.stubGlobal('MediaStream', Stream);
  vi.stubGlobal('RTCPeerConnection', FakeConnection);
  signaling = {
    description: vi.fn(async (): Promise<CommandAck> => ({ ok: true })),
  } as unknown as RoomConnection;
  const media = {
    cameraTrack: () => camera,
    microphoneTrack: () => microphone,
    screenTrack: () => screen,
  } as unknown as LocalMedia;
  manager = new PeerManager(
    media,
    signaling,
    () => undefined,
    (message) => {
      errors.push(message);
    },
  );
});
afterEach(() => {
  manager.close();
  vi.unstubAllGlobals();
});

describe('PeerManager screen sharing and initial negotiation', () => {
  it('replaces every video sender without touching audio or producing an offer; new peers start with the screen', async () => {
    manager.sync('z', ['z', 'a', 'b'], []);
    screen = track('video');
    await manager.replaceVideoTrack(screen);
    manager.sync('z', ['z', 'a', 'b', 'c'], []);
    for (const pc of connections) {
      expect(pc.getTransceivers().map((t) => t.sender.track)).toEqual([microphone, screen]);
      expect(pc.setLocalDescription).not.toHaveBeenCalled();
    }
    camera.enabled = false;
    await manager.replaceVideoTrack(camera);
    for (const pc of connections) expect(pc.getTransceivers()[1]?.sender.track).toBe(camera);
    expect(camera.enabled).toBe(false);
    camera.enabled = true;
    expect(signaling.description).not.toHaveBeenCalled();
  });

  it('replaces every audio sender and keeps one audio sender on each peer', async () => {
    manager.sync('z', ['z', 'a', 'b'], []);
    expect(connections).toHaveLength(2);
    for (const pc of connections) {
      pc.addTrack.mockClear();
      pc.addTransceiver.mockClear();
    }
    const next = track('audio');
    await manager.replaceAudioTrack(next);
    for (const pc of connections) {
      const audio = pc.getTransceivers().filter((item) => item.receiver.track.kind === 'audio');
      expect(audio).toHaveLength(1);
      expect(audio[0]?.sender.track).toBe(next);
      expect(pc.getTransceivers()).toHaveLength(2);
      expect(pc.getTransceivers()[1]?.sender.track).toBe(camera);
      expect(pc.addTrack).not.toHaveBeenCalled();
      expect(pc.addTransceiver).not.toHaveBeenCalled();
      expect(pc.setLocalDescription).not.toHaveBeenCalled();
    }
    expect(signaling.description).not.toHaveBeenCalled();
  });

  it('rejects an audio replacement only after every peer has settled', async () => {
    manager.sync('z', ['z', 'a', 'b'], []);
    const next = track('audio');
    const senders = connections.map(
      (pc) => pc.getTransceivers().find((item) => item.receiver.track.kind === 'audio')!.sender,
    );
    senders[0]!.replaceTrack.mockRejectedValueOnce(new Error('audio replace failed'));
    await expect(manager.replaceAudioTrack(next)).rejects.toThrow('audio replace failed');
    expect(senders[1]!.replaceTrack).toHaveBeenCalledWith(next);
    for (const pc of connections) {
      expect(
        pc.getTransceivers().filter((item) => item.receiver.track.kind === 'audio'),
      ).toHaveLength(1);
      expect(pc.addTrack).toHaveBeenCalledTimes(2);
      expect(pc.addTransceiver).not.toHaveBeenCalled();
    }
  });

  it('reports replacement failures after all peers settle so the caller can safely restore the camera', async () => {
    manager.sync('z', ['z', 'a', 'b'], []);
    connections[0]!
      .getTransceivers()[1]!
      .sender.replaceTrack.mockRejectedValueOnce(new Error('replace failed'));
    await expect(manager.replaceVideoTrack(track('video'))).rejects.toThrow('replace failed');
    await manager.replaceVideoTrack(camera);
    for (const pc of connections) expect(pc.getTransceivers()[1]?.sender.track).toBe(camera);
  });

  it('lets the impolite endpoint initiate and the polite endpoint answer with both tracks already attached', async () => {
    manager.sync('a', ['a', 'z'], []);
    const polite = connections[0]!;
    polite.onnegotiationneeded?.();
    expect(polite.setLocalDescription).not.toHaveBeenCalled();
    expect(polite.getTransceivers().map((t) => t.sender.track)).toEqual([microphone, camera]);
    manager.description({
      fromSocketId: 'z',
      toSocketId: 'a',
      description: { type: 'offer', sdp: 'test' },
    });
    await vi.waitFor(() =>
      expect(signaling.description).toHaveBeenCalledWith({
        toSocketId: 'z',
        description: { type: 'answer', sdp: 'test' },
      }),
    );
    manager.close();
    manager.sync('z', ['a', 'z'], []);
    connections[1]!.onnegotiationneeded?.();
    await vi.waitFor(() =>
      expect(signaling.description).toHaveBeenCalledWith({
        toSocketId: 'a',
        description: { type: 'offer', sdp: 'test' },
      }),
    );
  });
});

const answerSdp = 'v=0\r\na=ice-ufrag:new-ufrag\r\n';
const CANDIDATE_BYTES = 64 * 1024;
function ice(text: string, usernameFragment?: string): StageIceCandidate {
  return {
    candidate: text,
    sdpMid: '0',
    sdpMLineIndex: 0,
    ...(usernameFragment ? { usernameFragment } : {}),
  };
}
async function settle(): Promise<void> {
  for (let step = 0; step < 40; step += 1) await Promise.resolve();
}

describe('PeerManager ICE candidate queue', () => {
  it('applies early and during-ignore candidates that match the accepted answer and skips incompatible ones', async () => {
    manager.sync('z', ['a', 'z'], []);
    const pc = connections[0]!;
    pc.signalingState = 'have-local-offer';
    const from = (candidate: StageIceCandidate | null) => ({
      fromSocketId: 'a',
      toSocketId: 'z',
      candidate,
    });
    manager.candidate(from(ice('early', 'new-ufrag')));
    manager.candidate(from(ice('abandoned', 'old-ufrag')));
    manager.candidate(from(null));
    manager.description({
      fromSocketId: 'a',
      toSocketId: 'z',
      description: { type: 'offer', sdp: 'v=0\r\na=ice-ufrag:old-ufrag\r\n' },
    });
    manager.candidate(from(ice('during', 'new-ufrag')));
    manager.candidate(from(ice('during-old', 'old-ufrag')));
    manager.description({
      fromSocketId: 'a',
      toSocketId: 'z',
      description: { type: 'answer', sdp: answerSdp },
    });
    await vi.waitFor(() => expect(pc.addIceCandidate).toHaveBeenCalledTimes(3));
    expect(pc.addIceCandidate.mock.calls.map((call) => call[0])).toEqual([
      expect.objectContaining({ candidate: 'early', usernameFragment: 'new-ufrag' }),
      undefined,
      expect.objectContaining({ candidate: 'during', usernameFragment: 'new-ufrag' }),
    ]);
    expect(pc.setRemoteDescription).toHaveBeenCalledTimes(1);
    manager.candidate(from(ice('late-old', 'old-ufrag')));
    manager.candidate(from(ice('late-new', 'new-ufrag')));
    await vi.waitFor(() => expect(pc.addIceCandidate).toHaveBeenCalledTimes(4));
    expect(pc.addIceCandidate.mock.calls[3]?.[0]).toEqual(
      expect.objectContaining({ candidate: 'late-new', usernameFragment: 'new-ufrag' }),
    );
  });

  it('keeps applying later candidates and still answers when one candidate fails', async () => {
    manager.sync('a', ['a', 'z'], []);
    const pc = connections[0]!;
    pc.addIceCandidate
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new TypeError('invalid candidate'))
      .mockRejectedValueOnce(new Error('rejected'))
      .mockResolvedValueOnce(undefined);
    const from = (candidate: StageIceCandidate) => ({
      fromSocketId: 'z',
      toSocketId: 'a',
      candidate,
    });
    manager.candidate(from(ice('one')));
    manager.candidate(from({ candidate: 'bad', sdpMid: null, sdpMLineIndex: null }));
    manager.candidate(from(ice('three')));
    manager.candidate(from({ candidate: '', sdpMid: null, sdpMLineIndex: null }));
    manager.description({
      fromSocketId: 'z',
      toSocketId: 'a',
      description: { type: 'offer', sdp: answerSdp },
    });
    await vi.waitFor(() => expect(pc.addIceCandidate).toHaveBeenCalledTimes(4));
    expect(pc.addIceCandidate.mock.calls.map((call) => call[0])).toEqual([
      expect.objectContaining({ candidate: 'one' }),
      expect.objectContaining({ candidate: 'bad', sdpMid: null, sdpMLineIndex: null }),
      expect.objectContaining({ candidate: 'three' }),
      expect.objectContaining({ candidate: '', sdpMid: null, sdpMLineIndex: null }),
    ]);
    expect(errors).toEqual([
      'A stage media candidate was invalid. Later candidates will still be applied.',
      'A stage media candidate was rejected. Later candidates will still be applied.',
    ]);
    await vi.waitFor(() =>
      expect(signaling.description).toHaveBeenCalledWith({
        toSocketId: 'z',
        description: { type: 'answer', sdp: 'test' },
      }),
    );
  });

  it('keeps queued candidates when the remote description fails and applies them after a later success', async () => {
    manager.sync('a', ['a', 'z'], []);
    const pc = connections[0]!;
    pc.setRemoteDescription.mockRejectedValueOnce(new Error('bad sdp'));
    manager.candidate({
      fromSocketId: 'z',
      toSocketId: 'a',
      candidate: ice('kept', 'new-ufrag'),
    });
    manager.description({
      fromSocketId: 'z',
      toSocketId: 'a',
      description: { type: 'answer', sdp: 'not-sdp' },
    });
    await vi.waitFor(() =>
      expect(errors).toEqual(['Unable to connect stage media. Leave and join again to retry.']),
    );
    expect(pc.addIceCandidate).not.toHaveBeenCalled();
    manager.description({
      fromSocketId: 'z',
      toSocketId: 'a',
      description: { type: 'answer', sdp: answerSdp },
    });
    await vi.waitFor(() => expect(pc.addIceCandidate).toHaveBeenCalledTimes(1));
    expect(pc.addIceCandidate).toHaveBeenCalledWith(
      expect.objectContaining({ candidate: 'kept', usernameFragment: 'new-ufrag' }),
    );
  });

  it('releases the candidate queue on overflow', async () => {
    manager.sync('a', ['a', 'z'], []);
    const pc = connections[0]!;
    for (let index = 0; index < 33; index += 1) {
      manager.candidate({
        fromSocketId: 'z',
        toSocketId: 'a',
        candidate: ice(`c${index}`, 'new-ufrag'),
      });
    }
    manager.description({
      fromSocketId: 'z',
      toSocketId: 'a',
      description: { type: 'answer', sdp: answerSdp },
    });
    await vi.waitFor(() => expect(pc.setRemoteDescription).toHaveBeenCalled());
    await settle();
    expect(errors).toContain('Stage media candidates overflowed. Leave and join again to retry.');
    expect(pc.addIceCandidate).not.toHaveBeenCalled();

    manager.close();
    manager.sync('a', ['a', 'b'], []);
    const other = connections.at(-1)!;
    manager.candidate({
      fromSocketId: 'b',
      toSocketId: 'a',
      candidate: ice('x'.repeat(CANDIDATE_BYTES), 'new-ufrag'),
    });
    manager.description({
      fromSocketId: 'b',
      toSocketId: 'a',
      description: { type: 'answer', sdp: answerSdp },
    });
    await vi.waitFor(() => expect(other.setRemoteDescription).toHaveBeenCalled());
    await settle();
    expect(other.addIceCandidate).not.toHaveBeenCalled();
    expect(
      errors.filter(
        (message) =>
          message === 'Stage media candidates overflowed. Leave and join again to retry.',
      ),
    ).toHaveLength(2);
  });

  it('releases queued candidates when they expire before a description', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      manager.sync('a', ['a', 'z'], []);
      const pc = connections[0]!;
      manager.candidate({
        fromSocketId: 'z',
        toSocketId: 'a',
        candidate: ice('waiting', 'new-ufrag'),
      });
      await settle();
      await vi.advanceTimersByTimeAsync(7_999);
      expect(errors).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(errors).toEqual([
        'Stage media candidates expired before the connection was ready. Leave and join again to retry.',
      ]);
      manager.description({
        fromSocketId: 'z',
        toSocketId: 'a',
        description: { type: 'answer', sdp: answerSdp },
      });
      await settle();
      expect(pc.setRemoteDescription).toHaveBeenCalled();
      expect(pc.addIceCandidate).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops a queue closed during setRemoteDescription and ignores candidates after close', async () => {
    manager.sync('a', ['a', 'z'], []);
    const pc = connections[0]!;
    let release: () => void = () => undefined;
    pc.setRemoteDescription.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(undefined);
        }),
    );
    manager.candidate({
      fromSocketId: 'z',
      toSocketId: 'a',
      candidate: ice('closing', 'new-ufrag'),
    });
    manager.description({
      fromSocketId: 'z',
      toSocketId: 'a',
      description: { type: 'answer', sdp: answerSdp },
    });
    await vi.waitFor(() => expect(pc.setRemoteDescription).toHaveBeenCalled());
    manager.close();
    release();
    await settle();
    expect(pc.addIceCandidate).not.toHaveBeenCalled();
    manager.candidate({
      fromSocketId: 'z',
      toSocketId: 'a',
      candidate: ice('late', 'new-ufrag'),
    });
    await settle();
    expect(pc.addIceCandidate).not.toHaveBeenCalled();
  });
});
