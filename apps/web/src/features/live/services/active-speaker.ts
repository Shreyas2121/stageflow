type AudioInput = {
  track: MediaStreamTrack;
  source: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
  samples: Float32Array<ArrayBuffer>;
};

export class ActiveSpeaker {
  private context: AudioContext | null = null;
  private inputs = new Map<string, AudioInput>();
  private frame: number | null = null;
  private active: string | null = null;
  private pending: string | null = null;
  private leadingSince = 0;

  constructor(private publish: (participantId: string | null) => void) {}

  sync(tracks: ReadonlyMap<string, MediaStreamTrack>): void {
    for (const [id, input] of this.inputs) {
      if (tracks.get(id) !== input.track || input.track.readyState === 'ended') {
        input.source.disconnect();
        input.analyser.disconnect();
        this.inputs.delete(id);
      }
    }
    for (const [id, track] of tracks) {
      if (this.inputs.has(id) || track.readyState === 'ended') continue;
      this.context ??= new AudioContext();
      const source = this.context.createMediaStreamSource(new MediaStream([track]));
      const analyser = this.context.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      // No destination connection: remote tiles own playback, and local audio stays muted.
      this.inputs.set(id, { track, source, analyser, samples: new Float32Array(analyser.fftSize) });
    }
    if (this.active && !this.inputs.has(this.active)) this.highlight(null);
    if (this.pending && !this.inputs.has(this.pending)) this.pending = null;
    if (!this.inputs.size) {
      this.close();
      return;
    }
    void this.context?.resume().catch(() => undefined);
    if (this.frame === null) this.frame = requestAnimationFrame(this.sample);
  }

  private highlight(id: string | null): void {
    if (this.active === id) return;
    this.active = id;
    this.publish(id);
  }

  private sample = (now: number): void => {
    let leader: string | null = null;
    let highest = 0.08;
    for (const [id, input] of this.inputs) {
      if (!input.track.enabled || input.track.readyState !== 'live') continue;
      input.analyser.getFloatTimeDomainData(input.samples);
      const level = Math.sqrt(
        input.samples.reduce((sum, value) => sum + value * value, 0) / input.samples.length,
      );
      if (
        level >= 0.08 &&
        (leader === null || level > highest || (level === highest && id === this.active))
      ) {
        leader = id;
        highest = level;
      }
    }
    if (leader === null || leader === this.active) {
      this.pending = null;
      if (leader === null) this.highlight(null);
    } else if (leader !== this.pending) {
      this.pending = leader;
      this.leadingSince = now;
    } else if (now - this.leadingSince >= 300) {
      this.highlight(leader);
      this.pending = null;
    }
    this.frame = requestAnimationFrame(this.sample);
  };

  close(): void {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    for (const { source, analyser } of this.inputs.values()) {
      source.disconnect();
      analyser.disconnect();
    }
    this.inputs.clear();
    if (this.context) void this.context.close().catch(() => undefined);
    this.context = null;
    this.pending = null;
    this.leadingSince = 0;
    this.highlight(null);
  }
}
