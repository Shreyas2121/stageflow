export type DeviceChoices = { cameraId: string; microphoneId: string };

export class LocalMedia {
  private streams: MediaStream[] = [];
  private context: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private frame: number | null = null;
  private preview: HTMLVideoElement | null = null;
  private generation = 0;
  private screen: MediaStream | null = null;
  private screenGeneration = 0;

  async prepare(
    video: HTMLVideoElement,
    choices: DeviceChoices,
    onLevel: (level: number) => void,
  ): Promise<boolean> {
    this.stop();
    const generation = this.generation;
    this.preview = video;
    try {
      for (const kind of ['camera', 'microphone'] as const) {
        const id = kind === 'camera' ? choices.cameraId : choices.microphoneId;
        const constraints = id ? { deviceId: { exact: id } } : true;
        let stream: MediaStream;
        try {
          if (!navigator.mediaDevices?.getUserMedia)
            throw new Error('Media devices are unavailable.');
          stream = await navigator.mediaDevices.getUserMedia(
            kind === 'camera'
              ? { video: constraints, audio: false }
              : { audio: constraints, video: false },
          );
        } catch {
          throw new Error(
            `Unable to use your ${kind}. Allow ${kind} permission and check the selected device, then try again.`,
          );
        }
        // Permission prompts may finish after navigation or another device selection.
        if (generation !== this.generation) {
          stream.getTracks().forEach((track) => track.stop());
          return false;
        }
        this.streams.push(stream);
      }
      const camera = this.streams[0]!;
      const microphone = this.streams[1]!;
      video.srcObject = camera;
      await video.play();
      if (generation !== this.generation) return false;
      this.context = new AudioContext();
      this.source = this.context.createMediaStreamSource(microphone);
      const analyser = this.context.createAnalyser();
      analyser.fftSize = 256;
      this.source.connect(analyser);
      await this.context.resume();
      if (generation !== this.generation) return false;
      const samples = new Float32Array(analyser.fftSize);
      const meter = () => {
        if (generation !== this.generation) return;
        analyser.getFloatTimeDomainData(samples);
        const rms = Math.sqrt(
          samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length,
        );
        onLevel(Math.min(1, rms * 4));
        this.frame = requestAnimationFrame(meter);
      };
      meter();
      return true;
    } catch (error) {
      if (generation !== this.generation) return false;
      this.stop();
      throw error;
    }
  }

  applyFlags(isAudioMuted: boolean, isVideoOff: boolean): void {
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

  async setSpeaker(deviceId: string): Promise<boolean> {
    const preview = this.preview as
      (HTMLVideoElement & { setSinkId?: (id: string) => Promise<void> }) | null;
    if (!preview?.setSinkId) return false;
    if (preview.sinkId !== deviceId) await preview.setSinkId(deviceId);
    return true;
  }

  stop(): void {
    this.generation += 1;
    this.stopScreenShare();
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    this.source?.disconnect();
    this.source = null;
    if (this.context) void this.context.close().catch(() => undefined);
    this.context = null;
    for (const stream of this.streams) stream.getTracks().forEach((track) => track.stop());
    this.streams = [];
    if (this.preview) this.preview.srcObject = null;
    this.preview = null;
  }
}
