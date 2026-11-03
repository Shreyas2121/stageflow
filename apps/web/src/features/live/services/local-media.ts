import { routeAudioOutput, type OutputRouteResult } from './output-route';

export type DeviceChoices = { cameraId: string; microphoneId: string };
export type InputKind = 'camera' | 'microphone';

const METER_INTERVAL_MS = 100;

type HeldInput = { kind: InputKind; stream: MediaStream; track: MediaStreamTrack };

function inputRequest(kind: InputKind, deviceId: string): MediaStreamConstraints {
  const requested: boolean | MediaTrackConstraints = deviceId
    ? { deviceId: { exact: deviceId } }
    : true;
  return kind === 'camera'
    ? { video: requested, audio: false }
    : { audio: requested, video: false };
}

function inputError(kind: InputKind): Error {
  return new Error(
    `Unable to use your ${kind}. Allow ${kind} permission and check the selected device, then try again.`,
  );
}

export class LocalMedia {
  private streams: MediaStream[] = [];
  private context: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private meterTimer: ReturnType<typeof setTimeout> | null = null;
  private meterGeneration = 0;
  private preview: HTMLVideoElement | null = null;
  private levelListener: ((level: number) => void) | null = null;
  private generation = 0;
  private screen: MediaStream | null = null;
  private screenGeneration = 0;
  private isAudioMuted = false;
  private isVideoOff = false;
  private inputGeneration = 0;
  private replacement: Promise<void> = Promise.resolve();
  private heldInput: HeldInput | null = null;

  setLevelListener(listener: ((level: number) => void) | null): void {
    this.levelListener = listener;
  }

  async prepare(video: HTMLVideoElement, choices: DeviceChoices): Promise<boolean> {
    this.levelListener?.(0);
    this.stop();
    const generation = this.generation;
    this.preview = video;
    const stale = () => generation !== this.generation;
    try {
      for (const kind of ['camera', 'microphone'] as const) {
        const id = kind === 'camera' ? choices.cameraId : choices.microphoneId;
        const stream = await this.capture(kind, id);
        if (stale()) {
          stream.getTracks().forEach((track) => track.stop());
          return false;
        }
        this.streams.push(stream);
        this.applyFlags(this.isAudioMuted, this.isVideoOff);
      }
      const camera = this.streams[0]!;
      const microphone = this.streams[1]!;
      video.srcObject = camera;
      await video.play();
      if (stale()) return false;
      const context = new AudioContext();
      this.context = context;
      this.source = context.createMediaStreamSource(microphone);
      const analyser = context.createAnalyser();
      analyser.fftSize = 256;
      this.source.connect(analyser);
      await context.resume();
      if (stale()) {
        this.discardContext(context);
        return false;
      }
      const samples = new Float32Array(analyser.fftSize);
      const meterGeneration = ++this.meterGeneration;
      const tick = () => {
        if (meterGeneration !== this.meterGeneration) return;
        analyser.getFloatTimeDomainData(samples);
        const rms = Math.sqrt(
          samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length,
        );
        this.levelListener?.(Math.min(1, rms * 4));
        if (meterGeneration !== this.meterGeneration) return;
        this.meterTimer = setTimeout(tick, METER_INTERVAL_MS);
      };
      tick();
      return true;
    } catch (error) {
      if (stale()) return false;
      this.stop();
      throw error;
    }
  }

  replaceInput(kind: InputKind, deviceId: string): Promise<MediaStreamTrack | null> {
    const attempt = ++this.inputGeneration;
    const result = this.replacement.then(() => this.finishReplacement(kind, deviceId, attempt));
    this.replacement = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  commitInput(kind: InputKind, track: MediaStreamTrack): void {
    const held = this.heldInput;
    if (!held || held.track !== track || held.kind !== kind) {
      if (held?.track === track) this.heldInput = null;
      track.stop();
      return;
    }
    this.heldInput = null;
    const index = this.storedIndex(kind);
    const previous = index >= 0 ? this.streams[index] : undefined;
    if (index >= 0) this.streams[index] = held.stream;
    else this.streams.push(held.stream);
    if (previous && previous !== held.stream) previous.getTracks().forEach((item) => item.stop());
  }

  abortInput(track: MediaStreamTrack): void {
    if (this.heldInput?.track === track) {
      const held = this.heldInput;
      this.heldInput = null;
      held.stream.getTracks().forEach((item) => item.stop());
      return;
    }
    track.stop();
  }

  applyFlags(isAudioMuted: boolean, isVideoOff: boolean): void {
    this.isAudioMuted = isAudioMuted;
    this.isVideoOff = isVideoOff;
    for (const stream of this.streams) {
      stream.getAudioTracks().forEach((track) => {
        track.enabled = !isAudioMuted;
      });
      stream.getVideoTracks().forEach((track) => {
        track.enabled = !isVideoOff;
      });
    }
  }

  get ready(): boolean {
    return (
      this.streams.length === 2 &&
      this.streams.every(
        (stream) =>
          stream.getTracks().length > 0 &&
          stream.getTracks().every((track) => track.readyState === 'live'),
      )
    );
  }

  cameraTrack(): MediaStreamTrack | null {
    return (
      this.streams
        .flatMap((stream) => stream.getVideoTracks())
        .find((track) => track.readyState === 'live') ?? null
    );
  }

  microphoneTrack(): MediaStreamTrack | null {
    return (
      this.streams
        .flatMap((stream) => stream.getAudioTracks())
        .find((track) => track.readyState === 'live') ?? null
    );
  }

  previewStream(): MediaStream | null {
    return this.screenTrack()?.readyState === 'live' ? this.screen : (this.streams[0] ?? null);
  }

  screenTrack(): MediaStreamTrack | null {
    return this.screen?.getVideoTracks()[0] ?? null;
  }

  async startScreenShare(): Promise<MediaStreamTrack> {
    this.stopScreenShare();
    const generation = this.screenGeneration;
    if (!navigator.mediaDevices?.getDisplayMedia)
      throw new Error('Screen sharing is unavailable in this browser.');
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    const track = stream.getVideoTracks()[0];
    if (generation !== this.screenGeneration || !track || track.readyState !== 'live') {
      stream.getTracks().forEach((captured) => captured.stop());
      throw new Error('Screen sharing ended before it could start.');
    }
    this.screen = stream;
    return track;
  }

  stopScreenShare(): void {
    this.screenGeneration += 1;
    const track = this.screenTrack();
    if (track) track.onended = null;
    this.screen?.getTracks().forEach((captured) => captured.stop());
    this.screen = null;
  }

  async setSpeaker(deviceId: string): Promise<OutputRouteResult> {
    if (!this.preview) return { ok: true, supported: false, deviceId: '', message: '' };
    return routeAudioOutput(this.preview, deviceId);
  }

  releaseLobby(): void {
    this.detachPreview();
    this.stopMeter();
  }

  stop(): void {
    this.generation += 1;
    this.inputGeneration += 1;
    this.stopScreenShare();
    this.releaseLobby();
    const held = this.heldInput;
    this.heldInput = null;
    for (const stream of this.streams) stream.getTracks().forEach((track) => track.stop());
    this.streams = [];
    held?.stream.getTracks().forEach((track) => track.stop());
  }

  private async capture(kind: InputKind, deviceId: string): Promise<MediaStream> {
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('Media devices are unavailable.');
      return await navigator.mediaDevices.getUserMedia(inputRequest(kind, deviceId));
    } catch {
      throw inputError(kind);
    }
  }

  private async finishReplacement(
    kind: InputKind,
    deviceId: string,
    attempt: number,
  ): Promise<MediaStreamTrack | null> {
    if (attempt !== this.inputGeneration) return null;
    let stream: MediaStream;
    try {
      stream = await this.capture(kind, deviceId);
    } catch (error) {
      if (attempt !== this.inputGeneration) return null;
      throw error;
    }
    if (attempt !== this.inputGeneration) {
      stream.getTracks().forEach((track) => track.stop());
      return null;
    }
    const track = (kind === 'camera' ? stream.getVideoTracks() : stream.getAudioTracks()).find(
      (item) => item.readyState === 'live',
    );
    if (!track) {
      stream.getTracks().forEach((item) => item.stop());
      if (attempt !== this.inputGeneration) return null;
      throw inputError(kind);
    }
    track.enabled = kind === 'microphone' ? !this.isAudioMuted : !this.isVideoOff;
    if (attempt !== this.inputGeneration) {
      stream.getTracks().forEach((item) => item.stop());
      return null;
    }
    const previousHold = this.heldInput;
    this.heldInput = { kind, stream, track };
    if (previousHold && previousHold.stream !== stream)
      previousHold.stream.getTracks().forEach((item) => item.stop());
    return track;
  }

  private storedIndex(kind: InputKind): number {
    return this.streams.findIndex(
      (stream) =>
        (kind === 'camera' ? stream.getVideoTracks() : stream.getAudioTracks()).length > 0,
    );
  }

  private discardContext(context: AudioContext): void {
    if (this.context === context) {
      this.source?.disconnect();
      this.source = null;
      this.context = null;
    }
    void context.close().catch(() => undefined);
  }

  private stopMeter(): void {
    this.meterGeneration += 1;
    if (this.meterTimer !== null) clearTimeout(this.meterTimer);
    this.meterTimer = null;
    this.source?.disconnect();
    this.source = null;
    if (this.context) void this.context.close().catch(() => undefined);
    this.context = null;
  }

  private detachPreview(): void {
    const preview = this.preview;
    this.preview = null;
    if (!preview) return;
    preview.pause();
    preview.srcObject = null;
  }
}
