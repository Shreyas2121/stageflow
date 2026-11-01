import { demoPeerNames, type IceServer, type RoomSnapshot } from '@stageflow/shared';
import { createGuest } from '../api';
import { PeerManager, type TrackSource } from './peer-manager';
import { openIndependentSignaling, type RoomConnection } from './signaling';

// Leave room above the existing 0.08 speaker threshold after remote audio decoding.
const pulseGain = 0.24;

export class DemoPeer implements TrackSource {
  private connection: RoomConnection | null = null;
  private manager: PeerManager | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private video: MediaStreamTrack | null = null;
  private audio: MediaStreamTrack | null = null;
  private oscillator: OscillatorNode | null = null;
  private oscillatorStarted = false;
  private gain: GainNode | null = null;
  private frame: number | null = null;
  private snapshot: RoomSnapshot | null = null;
  private selfSocketId: string | null = null;
  private iceServers: IceServer[] = [];
  private stopped = false;
  private started = false;

  constructor(
    readonly name: string,
    private context: AudioContext,
    private onError: (message: string) => void = () => undefined,
    private onStopped: () => void = () => undefined,
  ) {}

  microphoneTrack(): MediaStreamTrack | null {
    return this.audio;
  }
  cameraTrack(): MediaStreamTrack | null {
    return this.video;
  }
  screenTrack(): null {
    return null;
  }

  private sync(): void {
    if (this.stopped || !this.selfSocketId || !this.snapshot) return;
    this.manager?.sync(this.selfSocketId, this.snapshot.stageSocketIds, this.iceServers);
  }

  async start(roomId: string): Promise<void> {
    if (this.started || this.stopped)
      throw new Error('This demo peer has already started or stopped.');
    this.started = true;
    try {
      if (this.context.state !== 'running')
        throw new Error('Enable demo audio by clicking Spawn demo peer again.');
      this.createMedia();
      const guest = await createGuest(this.name);
      if (this.stopped) throw new Error('Demo peer start was cancelled.');
      const connection = openIndependentSignaling(guest.token, roomId, {
        onJoined: (ack) => {
          this.selfSocketId = ack.selfSocketId;
          this.iceServers = ack.iceServers;
          this.sync();
        },
        onState: (snapshot) => {
          if (snapshot.revision <= (this.snapshot?.revision ?? -1)) return;
          this.snapshot = snapshot;
          this.sync();
        },
        onDescription: (payload) => this.manager?.description(payload),
        onCandidate: (payload) => this.manager?.candidate(payload),
        onEnded: () => this.stop(),
        onDisconnect: () => this.stop(),
      });
      this.connection = connection;
      this.manager = new PeerManager(this, connection, () => undefined, this.onError);
      const result = await connection.join({
        roomId,
        isAudioMuted: false,
        isVideoOff: false,
        isSyntheticBot: true,
      });
      if (this.stopped) throw new Error('Demo peer start was cancelled.');
      if (!result.ok) throw new Error(result.message);
    } catch (error) {
      this.stop();
      throw error;
    }
  }

  private createMedia(): void {
    const canvas = document.createElement('canvas');
    this.canvas = canvas;
    canvas.width = 640;
    canvas.height = 360;
    const drawing = canvas.getContext('2d');
    if (!drawing) throw new Error('Unable to draw a demo peer in this browser.');
    this.video = canvas.captureStream(24).getVideoTracks()[0] ?? null;
    if (!this.video) throw new Error('Unable to capture the demo canvas.');
    const destination = this.context.createMediaStreamDestination();
    this.audio = destination.stream.getAudioTracks()[0] ?? null;
    if (!this.audio) throw new Error('Unable to create demo audio.');
    this.oscillator = this.context.createOscillator();
    this.gain = this.context.createGain();
    this.gain.gain.value = 0;
    this.oscillator.frequency.value = 220;
    this.oscillator.connect(this.gain);
    this.gain.connect(destination);
    this.oscillator.start();
    this.oscillatorStarted = true;
    const pulseOffset = Math.max(
      0,
      demoPeerNames.findIndex((name) => name === this.name),
    );
    let nextPulse = this.context.currentTime + 0.15 + pulseOffset * 1.1;
    let pulseStarted = -Infinity;
    let lastFrame = -Infinity;
    let frames = 0;
    const draw = (now: number) => {
      if (this.stopped) return;
      const time = this.context.currentTime;
      if (time >= nextPulse) {
        this.gain!.gain.setValueAtTime(0, time);
        this.gain!.gain.linearRampToValueAtTime(pulseGain, time + 0.03);
        this.gain!.gain.setValueAtTime(pulseGain, time + 0.65);
        this.gain!.gain.linearRampToValueAtTime(0, time + 0.75);
        pulseStarted = time;
        nextPulse = time + 4;
      }
      if (now - lastFrame >= 1000 / 24) {
        lastFrame = Number.isFinite(lastFrame) ? now - ((now - lastFrame) % (1000 / 24)) : now;
        const role =
          this.snapshot?.participants.find(
            (participant) => participant.socketId === this.selfSocketId,
          )?.role ?? 'Joining';
        const level = time - pulseStarted < 0.75 ? pulseGain : 0;
        drawing.fillStyle = '#101b22';
        drawing.fillRect(0, 0, 640, 360);
        drawing.fillStyle = '#c9e798';
        drawing.font = 'bold 42px sans-serif';
        drawing.fillText(this.name, 40, 100);
        drawing.fillStyle = '#edf0eb';
        drawing.font = '22px sans-serif';
        drawing.fillText(role, 40, 150);
        drawing.fillText(`Frame ${++frames}`, 40, 300);
        drawing.fillStyle = '#343b3d';
        drawing.fillRect(40, 200, 560, 24);
        drawing.fillStyle = '#c9e798';
        drawing.fillRect(40, 200, (560 * level) / pulseGain, 24);
      }
      this.frame = requestAnimationFrame(draw);
    };
    this.frame = requestAnimationFrame(draw);
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    const connection = this.connection;
    this.connection = null;
    if (connection) {
      void connection.leave().catch(() => undefined);
      connection.close();
    }
    this.manager?.close();
    this.manager = null;
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    if (this.oscillatorStarted) this.oscillator?.stop();
    this.oscillator?.disconnect();
    this.gain?.disconnect();
    this.audio?.stop();
    this.video?.stop();
    this.audio = null;
    this.video = null;
    if (this.canvas) this.canvas.width = this.canvas.height = 0;
    this.canvas = null;
    void this.context.close().catch(() => undefined);
    this.onStopped();
  }
}
