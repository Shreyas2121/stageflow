import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandAck } from '@stageflow/shared';
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
  addTrack(track: MediaStreamTrack): Transceiver {
    const transceiver = { sender: senderFor(track), receiver: { track: { kind: track.kind } } };
    this.transceivers.push(transceiver);
    return transceiver;
  }
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
}
const camera = track('video');
const microphone = track('audio');
let screen: MediaStreamTrack | null;
let manager: PeerManager;
let signaling: RoomConnection;

beforeEach(() => {
  connections.length = 0;
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
    () => undefined,
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
