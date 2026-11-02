import {
  meshPeers,
  reduceNegotiation,
  type IceServer,
  type NegotiationEvent,
  type NegotiationFlags,
  type RelayedDescription,
  type RelayedIceCandidate,
  type StageIceCandidate,
  type CommandAck,
} from '@stageflow/shared';
import type { RoomConnection } from './signaling';

const CANDIDATE_QUEUE_LIMIT = 32;
const CANDIDATE_QUEUE_BYTES = 64 * 1024;
const CANDIDATE_QUEUE_MS = 8_000;

export type TrackSource = {
  microphoneTrack: () => MediaStreamTrack | null;
  cameraTrack: () => MediaStreamTrack | null;
  screenTrack: () => MediaStreamTrack | null;
};

type Peer = {
  pc: RTCPeerConnection;
  stream: MediaStream;
  flags: NegotiationFlags;
  candidates: (StageIceCandidate | null)[];
  queuedBytes: number;
  queueTimer: ReturnType<typeof setTimeout> | undefined;
  work: Promise<void>;
};

function candidateBytes(candidate: StageIceCandidate | null): number {
  if (!candidate) return 1;
  return (
    candidate.candidate.length +
    (candidate.sdpMid?.length ?? 0) +
    (candidate.usernameFragment?.length ?? 0)
  );
}

function remoteUfrags(sdp: string): Set<string> {
  const ufrags = new Set<string>();
  for (const line of sdp.split('\n')) {
    const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line;
    const prefix = 'a=ice-ufrag:';
    if (trimmed.startsWith(prefix)) ufrags.add(trimmed.slice(prefix.length));
  }
  return ufrags;
}

function candidateMatches(sdp: string | undefined, candidate: StageIceCandidate | null): boolean {
  if (!candidate?.usernameFragment) return true;
  if (!sdp) return false;
  return remoteUfrags(sdp).has(candidate.usernameFragment);
}

function toInit(candidate: StageIceCandidate): RTCIceCandidateInit {
  return {
    candidate: candidate.candidate,
    sdpMid: candidate.sdpMid,
    sdpMLineIndex: candidate.sdpMLineIndex,
    ...(candidate.usernameFragment ? { usernameFragment: candidate.usernameFragment } : {}),
  };
}
export type RemoteStreams = ReadonlyMap<string, MediaStream>;
export type PeerStatsSource = {
  readonly socketId: string;
  /** Stable for one connection, even when source wrappers are recreated. */
  readonly identity: object;
  readonly getStats: () => Promise<RTCStatsReport>;
};

export class PeerManager {
  private peers = new Map<string, Peer>();
  private elements = new Set<HTMLVideoElement>();

  constructor(
    private media: TrackSource,
    private signaling: RoomConnection,
    private publish: (streams: RemoteStreams) => void,
    private onError: (message: string) => void,
  ) {}

  private changed(): void {
    this.publish(new Map([...this.peers].map(([id, peer]) => [id, peer.stream])));
  }

  statsConnections(): readonly PeerStatsSource[] {
    return [...this.peers].map(([socketId, { pc }]) => ({
      socketId,
      identity: pc,
      getStats: () => pc.getStats(),
    }));
  }

  private alive(id: string, peer: Peer): boolean {
    return this.peers.get(id) === peer;
  }

  private decide(peer: Peer, event: NegotiationEvent) {
    const result = reduceNegotiation(
      {
        ...peer.flags,
        signalingState: peer.pc.signalingState,
        remoteDescriptionSet: peer.pc.remoteDescription !== null,
      },
      event,
    );
    peer.flags = result.flags;
    return result.action;
  }

  private enqueue(id: string, peer: Peer, action: () => Promise<void>): void {
    peer.work = peer.work
      .then(async () => {
        if (this.alive(id, peer)) await action();
      })
      .catch(() => {
        if (this.alive(id, peer))
          this.onError('Unable to connect stage media. Leave and join again to retry.');
      });
  }

  private async acknowledged(result: Promise<CommandAck>): Promise<void> {
    const ack = await result;
    if (!ack.ok) throw new Error(ack.error);
  }

  sync(selfSocketId: string, stageSocketIds: readonly string[], iceServers: IceServer[]): void {
    const wanted = new Set(meshPeers(selfSocketId, stageSocketIds));
    for (const [id, peer] of this.peers) {
      if (!wanted.has(id)) {
        this.dispose(peer);
        this.peers.delete(id);
      }
    }
    for (const id of wanted) {
      if (this.peers.has(id)) continue;
      const pc = new RTCPeerConnection({ iceServers, bundlePolicy: 'max-bundle' });
      const peer: Peer = {
        pc,
        stream: new MediaStream(),
        candidates: [],
        queuedBytes: 0,
        queueTimer: undefined,
        work: Promise.resolve(),
        flags: {
          polite: selfSocketId < id,
          makingOffer: false,
          ignoreOffer: false,
          isSettingRemoteAnswerPending: false,
          signalingState: 'stable',
          remoteDescriptionSet: false,
        },
      };
      this.peers.set(id, peer);
      // addTrack creates sendrecv transceivers that can be reused after glare rollback.
      // Explicit addTransceiver transceivers cannot be reassociated with an incoming offer:
      // https://www.w3.org/TR/webrtc/#dom-rtcpeerconnection-addtransceiver
      // Assign both captured tracks before installing the negotiation handler.
      const audio = this.media.microphoneTrack();
      const screen = this.media.screenTrack();
      const video = screen?.readyState === 'live' ? screen : this.media.cameraTrack();
      const localStream = new MediaStream(
        [audio, video].filter((track): track is MediaStreamTrack => track !== null),
      );
      if (audio) pc.addTrack(audio, localStream);
      else pc.addTransceiver('audio', { direction: 'sendrecv' });
      if (video) pc.addTrack(video, localStream);
      else pc.addTransceiver('video', { direction: 'sendrecv' });
      pc.onnegotiationneeded = () => {
        // Let the impolite endpoint start a new pair. This avoids two initial ICE
        // gatherings racing a rollback; inbound glare decisions still belong to the reducer.
        if (peer.flags.polite && !pc.remoteDescription) return;
        this.enqueue(id, peer, async () => {
          if (this.decide(peer, { type: 'negotiation-needed' }) !== 'send-offer') return;
          try {
            await pc.setLocalDescription();
            if (this.alive(id, peer)) await this.sendDescription(id, peer);
          } finally {
            this.decide(peer, { type: 'local-offer-finished' });
          }
        });
      };
      pc.onicecandidate = ({ candidate }) => {
        if (!this.alive(id, peer)) return;
        void this.acknowledged(
          this.signaling.candidate({
            toSocketId: id,
            candidate: candidate
              ? {
                  candidate: candidate.candidate,
                  sdpMid: candidate.sdpMid,
                  sdpMLineIndex: candidate.sdpMLineIndex,
                  ...(candidate.usernameFragment
                    ? { usernameFragment: candidate.usernameFragment }
                    : {}),
                }
              : null,
          }),
        ).catch(() => {
          if (this.alive(id, peer))
            this.onError('Unable to send stage media candidates. Leave and join again to retry.');
        });
      };
      pc.ontrack = ({ track }) => {
        if (!this.alive(id, peer)) return;
        for (const previous of peer.stream.getTracks()) {
          if (previous.kind === track.kind && previous !== track) peer.stream.removeTrack(previous);
        }
        peer.stream.addTrack(track);
        this.changed();
      };
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed' && this.alive(id, peer)) {
          this.onError('A stage media connection failed. Leave and join again to retry.');
        }
      };
    }
    this.changed();
  }

  private async sendDescription(id: string, peer: Peer): Promise<void> {
    const description = peer.pc.localDescription;
    if (!description || (description.type !== 'offer' && description.type !== 'answer')) return;
    await this.acknowledged(
      this.signaling.description({
        toSocketId: id,
        description: { type: description.type, sdp: description.sdp },
      }),
    );
  }

  description({ fromSocketId: id, description }: RelayedDescription): void {
    const peer = this.peers.get(id);
    if (!peer) return;
    this.enqueue(id, peer, async () => {
      const action = this.decide(peer, { type: 'description', description });
      if (action === 'ignore-description') return;
      peer.flags.isSettingRemoteAnswerPending = description.type === 'answer';
      try {
        await peer.pc.setRemoteDescription(description);
      } finally {
        peer.flags.isSettingRemoteAnswerPending = false;
      }
      if (!this.alive(id, peer)) return;
      await this.flushCandidates(id, peer);
      if (!this.alive(id, peer)) return;
      if (action === 'accept-offer') {
        await peer.pc.setLocalDescription();
        if (this.alive(id, peer)) await this.sendDescription(id, peer);
      }
    });
  }

  candidate({ fromSocketId: id, candidate }: RelayedIceCandidate): void {
    const peer = this.peers.get(id);
    if (!peer) return;
    this.enqueue(id, peer, async () => {
      const action = this.decide(peer, { type: 'candidate' });
      if (action === 'add-candidate') await this.applyCandidate(id, peer, candidate);
      else if (action === 'queue-candidate' || action === 'drop-candidate')
        this.retainCandidate(id, peer, candidate);
    });
  }

  private releaseQueue(peer: Peer): void {
    peer.candidates.length = 0;
    peer.queuedBytes = 0;
    if (peer.queueTimer) {
      clearTimeout(peer.queueTimer);
      peer.queueTimer = undefined;
    }
  }

  private retainCandidate(id: string, peer: Peer, candidate: StageIceCandidate | null): void {
    const bytes = candidateBytes(candidate);
    if (
      peer.candidates.length + 1 > CANDIDATE_QUEUE_LIMIT ||
      peer.queuedBytes + bytes > CANDIDATE_QUEUE_BYTES
    ) {
      this.releaseQueue(peer);
      this.onError('Stage media candidates overflowed. Leave and join again to retry.');
      return;
    }
    peer.candidates.push(candidate);
    peer.queuedBytes += bytes;
    if (peer.queueTimer) return;
    peer.queueTimer = setTimeout(() => {
      peer.queueTimer = undefined;
      if (!this.alive(id, peer) || peer.candidates.length === 0) return;
      this.releaseQueue(peer);
      this.onError(
        'Stage media candidates expired before the connection was ready. Leave and join again to retry.',
      );
    }, CANDIDATE_QUEUE_MS);
  }

  private async applyCandidate(
    id: string,
    peer: Peer,
    candidate: StageIceCandidate | null,
  ): Promise<void> {
    if (!candidateMatches(peer.pc.remoteDescription?.sdp, candidate)) return;
    try {
      await peer.pc.addIceCandidate(candidate ? toInit(candidate) : undefined);
    } catch (error) {
      if (!this.alive(id, peer)) return;
      this.onError(
        error instanceof TypeError
          ? 'A stage media candidate was invalid. Later candidates will still be applied.'
          : 'A stage media candidate was rejected. Later candidates will still be applied.',
      );
    }
  }

  private async flushCandidates(id: string, peer: Peer): Promise<void> {
    const batch = peer.candidates.slice();
    const sdp = peer.pc.remoteDescription?.sdp;
    this.releaseQueue(peer);
    for (const candidate of batch) {
      if (!this.alive(id, peer)) return;
      if (!candidateMatches(sdp, candidate)) continue;
      await this.applyCandidate(id, peer, candidate);
    }
  }

  attach(element: HTMLVideoElement): () => void {
    this.elements.add(element);
    return () => {
      element.srcObject = null;
      this.elements.delete(element);
    };
  }

  async replaceVideoTrack(track: MediaStreamTrack | null): Promise<void> {
    const results = await Promise.allSettled(
      [...this.peers.values()].map(async ({ pc }) => {
        const video = pc
          .getTransceivers()
          .find((transceiver) => transceiver.receiver.track.kind === 'video');
        if (video) await video.sender.replaceTrack(track);
      }),
    );
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }

  private dispose(peer: Peer): void {
    peer.pc.onnegotiationneeded = null;
    peer.pc.onicecandidate = null;
    peer.pc.ontrack = null;
    peer.pc.onconnectionstatechange = null;
    peer.pc.close();
    this.releaseQueue(peer);
    for (const element of this.elements) {
      if (element.srcObject === peer.stream) element.srcObject = null;
    }
  }

  close(): void {
    for (const peer of this.peers.values()) this.dispose(peer);
    this.peers.clear();
    for (const element of this.elements) element.srcObject = null;
    this.elements.clear();
    this.changed();
  }
}
