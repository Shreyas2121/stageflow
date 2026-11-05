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
function senderFor(track: MediaStreamTrack | null) {
  const sender = {
    track,
    replaceTrack: vi.fn(async (next: MediaStreamTrack | null) => {
      sender.track = next;
    }),
  };
  return sender;
}
type Transceiver = {
  sender: ReturnType<typeof senderFor>;
  receiver: { track: { kind: string } };
  mid: string | null;
  direction: RTCRtpTransceiverDirection;
  currentDirection: RTCRtpTransceiverDirection | null;
  stopped: boolean;
  origin: 'addTrack' | 'addTransceiver' | 'remote';
};

function transceiverFor(kind: string, origin: Transceiver['origin']): Transceiver {
  return {
    sender: senderFor(null),
    receiver: { track: { kind } },
    mid: null,
    direction: origin === 'remote' ? 'recvonly' : 'sendrecv',
    currentDirection: null,
    stopped: false,
    origin,
  };
}

function mediaSdp(kinds: readonly string[] = ['audio', 'video']): string {
  return kinds
    .map((kind, index) => `m=${kind} 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:${index}\r\n`)
    .join('');
}
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
  addTrack = vi.fn((mediaTrack: MediaStreamTrack) => {
    const transceiver = transceiverFor(mediaTrack.kind, 'addTrack');
    transceiver.sender.track = mediaTrack;
    this.transceivers.push(transceiver);
    return transceiver.sender;
  });
  addTransceiver = vi.fn((kind: string, init?: RTCRtpTransceiverInit): Transceiver => {
    const transceiver = transceiverFor(kind, 'addTransceiver');
    transceiver.direction = init?.direction ?? 'sendrecv';
    this.transceivers.push(transceiver);
    return transceiver;
  });
  getTransceivers() {
    return this.transceivers;
  }
  setLocalDescription = vi.fn(async () => {
    const type = this.signalingState === 'have-remote-offer' ? 'answer' : 'offer';
    this.transceivers.forEach((transceiver, index) => {
      if (type === 'offer') transceiver.mid ??= String(index);
      else if (transceiver.mid !== null) transceiver.currentDirection = transceiver.direction;
    });
    this.localDescription = { type, sdp: 'test' };
    this.signalingState = type === 'offer' ? 'have-local-offer' : 'stable';
  });
  setRemoteDescription = vi.fn(async (description: RTCSessionDescriptionInit) => {
    if (description.type === 'offer') {
      // Setting a colliding offer rolls back provisional local associations.
      if (this.signalingState === 'have-local-offer') {
        for (const transceiver of this.transceivers) {
          if (!transceiver.currentDirection) transceiver.mid = null;
        }
      }
      const sections =
        description.sdp?.split(/(?=m=)/).filter((section) => section.startsWith('m=')) ?? [];
      for (const section of sections) {
        const kind = /^m=(audio|video) /.exec(section)?.[1];
        const mid = /a=mid:([^\r\n]+)/.exec(section)?.[1];
        if (!kind || !mid) continue;
        let transceiver = this.transceivers.find((item) => item.mid === mid);
        // Only disassociated addTrack-created transceivers may answer a new m-line.
        transceiver ??= this.transceivers.find(
          (item) =>
            item.mid === null && item.origin === 'addTrack' && item.receiver.track.kind === kind,
        );
        if (!transceiver) {
          transceiver = transceiverFor(kind, 'remote');
          this.transceivers.push(transceiver);
        }
        transceiver.mid = mid;
      }
    }
    this.remoteDescription = description;
    this.signalingState = description.type === 'offer' ? 'have-remote-offer' : 'stable';
    if (description.type === 'answer') {
      for (const transceiver of this.transceivers) {
        if (transceiver.mid !== null) transceiver.currentDirection = transceiver.direction;
      }
    }
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
      fromParticipantId: 'z',
      toParticipantId: 'a',
      description: { type: 'offer', sdp: 'test' },
    });
    await vi.waitFor(() =>
      expect(signaling.description).toHaveBeenCalledWith({
        toParticipantId: 'z',
        description: { type: 'answer', sdp: 'test' },
      }),
    );
    manager.close();
    manager.sync('z', ['a', 'z'], []);
    connections[1]!.onnegotiationneeded?.();
    await vi.waitFor(() =>
      expect(signaling.description).toHaveBeenCalledWith({
        toParticipantId: 'a',
        description: { type: 'offer', sdp: 'test' },
      }),
    );
  });
});

describe('PeerManager media-off transceiver ownership', () => {
  function withoutCapture(
    audio: MediaStreamTrack | null = null,
    video: MediaStreamTrack | null = null,
  ) {
    manager.close();
    manager = new PeerManager(
      { microphoneTrack: () => audio, cameraTrack: () => video, screenTrack: () => null },
      signaling,
      () => undefined,
      (message) => errors.push(message),
    );
  }

  it('models the distinct incoming-offer association of addTrack and addTransceiver', async () => {
    const pc = new FakeConnection();
    const explicit = pc.addTransceiver('audio');
    const captured = pc.addTrack(camera);
    await pc.setRemoteDescription({ type: 'offer', sdp: mediaSdp() });
    expect(pc.getTransceivers()).toHaveLength(3);
    expect(explicit.mid).toBeNull();
    expect(pc.getTransceivers().find((item) => item.sender === captured)?.mid).toBe('1');
    expect(pc.getTransceivers().find((item) => item.mid === '0')?.origin).toBe('remote');
  });

  it("adopts the polite endpoint's offered pair and enables later capture on those same senders", async () => {
    withoutCapture();
    manager.sync('a', ['a', 'z'], []);
    const pc = connections[0]!;
    manager.description({
      fromParticipantId: 'z',
      toParticipantId: 'a',
      description: { type: 'offer', sdp: mediaSdp() },
    });
    await settle();
    const negotiated = pc.getTransceivers().filter((item) => item.mid !== null);
    expect(pc.getTransceivers()).toHaveLength(2);
    expect(negotiated).toHaveLength(2);
    expect(negotiated.map((item) => item.direction)).toEqual(['sendrecv', 'sendrecv']);
    expect(negotiated.map((item) => item.sender.track)).toEqual([null, null]);
    await manager.replaceAudioTrack(microphone);
    await manager.replaceVideoTrack(camera);
    expect(negotiated.map((item) => item.sender.track)).toEqual([microphone, camera]);
    expect(pc.getTransceivers()).toEqual(negotiated);
    expect(pc.setLocalDescription).toHaveBeenCalledTimes(1);
    expect(errors).toEqual([]);
  });

  it('keeps explicit activation made before the polite endpoint receives its offer', async () => {
    withoutCapture();
    manager.sync('a', ['a', 'z'], []);
    const pc = connections[0]!;
    await manager.replaceAudioTrack(microphone);
    await manager.replaceVideoTrack(camera);
    manager.description({
      fromParticipantId: 'z',
      toParticipantId: 'a',
      description: { type: 'offer', sdp: mediaSdp() },
    });
    await settle();
    expect(pc.getTransceivers()).toHaveLength(2);
    expect(pc.getTransceivers().map((item) => item.sender.track)).toEqual([microphone, camera]);
    expect(pc.getTransceivers().every((item) => item.mid !== null)).toBe(true);
    expect(errors).toEqual([]);
  });

  it.each(['audio', 'video'] as const)(
    'associates captured %s and adopts only the missing kind',
    async (kind) => {
      withoutCapture(kind === 'audio' ? microphone : null, kind === 'video' ? camera : null);
      manager.sync('a', ['a', 'z'], []);
      const pc = connections[0]!;
      const captured = pc.getTransceivers()[0]!;
      manager.description({
        fromParticipantId: 'z',
        toParticipantId: 'a',
        description: { type: 'offer', sdp: mediaSdp() },
      });
      await settle();
      expect(pc.getTransceivers()).toHaveLength(2);
      expect(pc.getTransceivers()).toContain(captured);
      expect(captured.mid).not.toBeNull();
      expect(
        pc.getTransceivers().every((item) => item.mid !== null && item.direction === 'sendrecv'),
      ).toBe(true);
      await manager.replaceAudioTrack(microphone);
      await manager.replaceVideoTrack(camera);
      expect(
        pc.getTransceivers().find((item) => item.receiver.track.kind === 'audio')?.sender.track,
      ).toBe(microphone);
      expect(
        pc.getTransceivers().find((item) => item.receiver.track.kind === 'video')?.sender.track,
      ).toBe(camera);
      expect(pc.setLocalDescription).toHaveBeenCalledTimes(1);
      expect(errors).toEqual([]);
    },
  );

  it('keeps adopted ownership through a polite glare rollback', async () => {
    withoutCapture();
    manager.sync('a', ['a', 'z'], []);
    const pc = connections[0]!;
    const incoming = {
      fromParticipantId: 'z',
      toParticipantId: 'a',
      description: { type: 'offer' as const, sdp: mediaSdp() },
    };
    manager.description(incoming);
    await settle();
    const owned = pc.getTransceivers().slice();
    pc.onnegotiationneeded?.();
    await settle();
    expect(pc.signalingState).toBe('have-local-offer');
    manager.description(incoming);
    await settle();
    expect(pc.signalingState).toBe('stable');
    expect(pc.getTransceivers()).toEqual(owned);
    await manager.replaceAudioTrack(microphone);
    await manager.replaceVideoTrack(camera);
    expect(owned.map((item) => item.sender.track)).toEqual([microphone, camera]);
    expect(pc.setLocalDescription).toHaveBeenCalledTimes(3);
    expect(errors).toEqual([]);
  });

  it('rejects ambiguous offered kinds instead of choosing an arbitrary sender', async () => {
    withoutCapture();
    manager.sync('a', ['a', 'z'], []);
    const pc = connections[0]!;
    manager.description({
      fromParticipantId: 'z',
      toParticipantId: 'a',
      description: { type: 'offer', sdp: mediaSdp(['audio', 'audio', 'video']) },
    });
    await settle();
    expect(errors).toEqual(['Unable to connect stage media. Leave and join again to retry.']);
    expect(pc.setLocalDescription).not.toHaveBeenCalled();
    expect(
      pc.getTransceivers().every((item) => item.sender.replaceTrack.mock.calls.length === 0),
    ).toBe(true);
  });

  it('stops adoption after a peer is closed during pending explicit activation', async () => {
    withoutCapture();
    manager.sync('a', ['a', 'z'], []);
    const pc = connections[0]!;
    await manager.replaceAudioTrack(microphone);
    const setRemote = pc.setRemoteDescription.getMockImplementation()!;
    let release!: () => void;
    pc.setRemoteDescription.mockImplementationOnce(async (description) => {
      await setRemote(description);
      pc.getTransceivers()[0]!.sender.replaceTrack.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );
    });
    manager.description({
      fromParticipantId: 'z',
      toParticipantId: 'a',
      description: { type: 'offer', sdp: mediaSdp() },
    });
    await vi.waitFor(() => expect(release).toBeDefined());
    manager.close();
    release();
    await settle();
    expect(pc.setLocalDescription).not.toHaveBeenCalled();
    expect(pc.getTransceivers()[1]!.sender.replaceTrack).not.toHaveBeenCalled();
    expect(errors).toEqual([]);
  });

  it('owns the impolite media-off pair before offering and replaces it without adding senders', async () => {
    withoutCapture();
    manager.sync('z', ['a', 'z'], []);
    const pc = connections[0]!;
    const owned = pc.getTransceivers().slice();
    expect(owned.map((item) => item.sender.track)).toEqual([null, null]);
    pc.onnegotiationneeded?.();
    await settle();
    await manager.replaceAudioTrack(microphone);
    await manager.replaceVideoTrack(camera);
    await manager.replaceAudioTrack(null);
    await manager.replaceVideoTrack(null);
    expect(pc.getTransceivers()).toEqual(owned);
    expect(owned.map((item) => item.sender.track)).toEqual([null, null]);
    expect(pc.addTransceiver).toHaveBeenCalledTimes(2);
    expect(pc.setLocalDescription).toHaveBeenCalledTimes(1);
    expect(errors).toEqual([]);
  });

  it('replaces the owned sender even if an unrelated same-kind transceiver precedes it', async () => {
    manager.sync('z', ['a', 'z'], []);
    const pc = connections[0]!;
    const owned = pc.getTransceivers().slice();
    const unrelated = transceiverFor('audio', 'remote');
    pc.transceivers.unshift(unrelated);
    const next = track('audio');
    await manager.replaceAudioTrack(next);
    expect(owned[0]!.sender.track).toBe(next);
    expect(unrelated.sender.replaceTrack).not.toHaveBeenCalled();
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
      fromParticipantId: 'a',
      toParticipantId: 'z',
      candidate,
    });
    manager.candidate(from(ice('early', 'new-ufrag')));
    manager.candidate(from(ice('abandoned', 'old-ufrag')));
    manager.candidate(from(null));
    manager.description({
      fromParticipantId: 'a',
      toParticipantId: 'z',
      description: { type: 'offer', sdp: 'v=0\r\na=ice-ufrag:old-ufrag\r\n' },
    });
    manager.candidate(from(ice('during', 'new-ufrag')));
    manager.candidate(from(ice('during-old', 'old-ufrag')));
    manager.description({
      fromParticipantId: 'a',
      toParticipantId: 'z',
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
      fromParticipantId: 'z',
      toParticipantId: 'a',
      candidate,
    });
    manager.candidate(from(ice('one')));
    manager.candidate(from({ candidate: 'bad', sdpMid: null, sdpMLineIndex: null }));
    manager.candidate(from(ice('three')));
    manager.candidate(from({ candidate: '', sdpMid: null, sdpMLineIndex: null }));
    manager.description({
      fromParticipantId: 'z',
      toParticipantId: 'a',
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
        toParticipantId: 'z',
        description: { type: 'answer', sdp: 'test' },
      }),
    );
  });

  it('keeps queued candidates when the remote description fails and applies them after a later success', async () => {
    manager.sync('a', ['a', 'z'], []);
    const pc = connections[0]!;
    pc.setRemoteDescription.mockRejectedValueOnce(new Error('bad sdp'));
    manager.candidate({
      fromParticipantId: 'z',
      toParticipantId: 'a',
      candidate: ice('kept', 'new-ufrag'),
    });
    manager.description({
      fromParticipantId: 'z',
      toParticipantId: 'a',
      description: { type: 'answer', sdp: 'not-sdp' },
    });
    await vi.waitFor(() =>
      expect(errors).toEqual(['Unable to connect stage media. Leave and join again to retry.']),
    );
    expect(pc.addIceCandidate).not.toHaveBeenCalled();
    manager.description({
      fromParticipantId: 'z',
      toParticipantId: 'a',
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
        fromParticipantId: 'z',
        toParticipantId: 'a',
        candidate: ice(`c${index}`, 'new-ufrag'),
      });
    }
    manager.description({
      fromParticipantId: 'z',
      toParticipantId: 'a',
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
      fromParticipantId: 'b',
      toParticipantId: 'a',
      candidate: ice('x'.repeat(CANDIDATE_BYTES), 'new-ufrag'),
    });
    manager.description({
      fromParticipantId: 'b',
      toParticipantId: 'a',
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
        fromParticipantId: 'z',
        toParticipantId: 'a',
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
        fromParticipantId: 'z',
        toParticipantId: 'a',
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
      fromParticipantId: 'z',
      toParticipantId: 'a',
      candidate: ice('closing', 'new-ufrag'),
    });
    manager.description({
      fromParticipantId: 'z',
      toParticipantId: 'a',
      description: { type: 'answer', sdp: answerSdp },
    });
    await vi.waitFor(() => expect(pc.setRemoteDescription).toHaveBeenCalled());
    manager.close();
    release();
    await settle();
    expect(pc.addIceCandidate).not.toHaveBeenCalled();
    manager.candidate({
      fromParticipantId: 'z',
      toParticipantId: 'a',
      candidate: ice('late', 'new-ufrag'),
    });
    await settle();
    expect(pc.addIceCandidate).not.toHaveBeenCalled();
  });
});
