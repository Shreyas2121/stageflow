import { ChunkUpload, postChunk, type ChunkSender } from './chunk-upload';

export const STAGE_WIDTH = 1280;
export const STAGE_HEIGHT = 720;
export const STAGE_FPS = 24;
export const CHUNK_INTERVAL_MS = 1000;
export const RECORDER_MIME = 'video/webm;codecs=vp8,opus';
export const VIDEO_BITS_PER_SECOND = 2_500_000;
const STAGE_BACKGROUND = '#0d1113';
const FRAME_MS = 1000 / STAGE_FPS;
/** HTMLMediaElement.HAVE_CURRENT_DATA. A video before this has no paintable frame. */
const HAVE_CURRENT_DATA = 2;

export type StageSource = {
  id: string;
  video: HTMLVideoElement | null;
  audioTrack: MediaStreamTrack | null;
  muted: boolean;
  screenSharing: boolean;
};

export type RecorderFinish =
  { ok: true } | { ok: false; reason: 'timeout' | 'upload' | 'aborted' | 'recorder' };

export type BroadcastRecorder = {
  start(): void;
  update(sources: readonly StageSource[]): void;
  /** Drops unsent media immediately and releases owned tracks. */
  stop(): void;
  /** Collects the final blob, uploads accepted chunks, then releases owned tracks. */
  finish(): Promise<RecorderFinish>;
};

/** Bounds the final-blob wait and, separately, the ordered upload that follows it. */
export const RECORDER_FINISH_MS = 8_000;
export const RECORDER_INPUT_MS = 12_000;

type FrameRect = { x: number; y: number; width: number; height: number };

const FULL_FRAME: FrameRect = { x: 0, y: 0, width: STAGE_WIDTH, height: STAGE_HEIGHT };
const GRID_CELLS: readonly FrameRect[] = [
  { x: 0, y: 0, width: STAGE_WIDTH / 2, height: STAGE_HEIGHT / 2 },
  { x: STAGE_WIDTH / 2, y: 0, width: STAGE_WIDTH / 2, height: STAGE_HEIGHT / 2 },
  { x: 0, y: STAGE_HEIGHT / 2, width: STAGE_WIDTH / 2, height: STAGE_HEIGHT / 2 },
  { x: STAGE_WIDTH / 2, y: STAGE_HEIGHT / 2, width: STAGE_WIDTH / 2, height: STAGE_HEIGHT / 2 },
];

/** One full frame, two columns, or a 2×2 grid. A screen share replaces every other frame. */
export function placeStageFrames(
  count: number,
  sharingIndex: number,
): { index: number; rect: FrameRect }[] {
  if (count <= 0) return [];
  if (sharingIndex >= 0 && sharingIndex < count) return [{ index: sharingIndex, rect: FULL_FRAME }];
  if (count === 1) return [{ index: 0, rect: FULL_FRAME }];
  if (count === 2) {
    return [0, 1].map((index) => ({
      index,
      rect: {
        x: index * (STAGE_WIDTH / 2),
        y: 0,
        width: STAGE_WIDTH / 2,
        height: STAGE_HEIGHT,
      },
    }));
  }
  return GRID_CELLS.slice(0, Math.min(count, GRID_CELLS.length)).map((rect, index) => ({
    index,
    rect,
  }));
}

function audibleTracks(sources: readonly StageSource[]): MediaStreamTrack[] {
  return sources.flatMap((source) =>
    !source.muted && source.audioTrack && source.audioTrack.readyState !== 'ended'
      ? [source.audioTrack]
      : [],
  );
}

export type StageRecorderOptions = {
  broadcastId: string;
  token: string;
  /** Terminal producer failure. The caller stops the broadcast, preserving room media. */
  onCap: () => void;
  send?: ChunkSender;
  createCanvas?: () => HTMLCanvasElement;
  createAudioContext?: () => AudioContext;
  createRecorder?: (stream: MediaStream, options: MediaRecorderOptions) => MediaRecorder;
  requestFrame?: (callback: FrameRequestCallback) => number;
  cancelFrame?: (handle: number) => void;
};

export class StageRecorder implements BroadcastRecorder {
  private readonly upload: ChunkUpload;
  private readonly requestFrame: (callback: FrameRequestCallback) => number;
  private readonly cancelFrame: (handle: number) => void;
  private readonly createCanvas: () => HTMLCanvasElement;
  private readonly createAudioContext: () => AudioContext;
  private readonly createRecorder: (
    stream: MediaStream,
    options: MediaRecorderOptions,
  ) => MediaRecorder;
  private sources: readonly StageSource[] = [];
  private audible: MediaStreamTrack[] = [];
  private nodes: MediaStreamAudioSourceNode[] = [];
  private canvas: HTMLCanvasElement | null = null;
  private drawing: CanvasRenderingContext2D | null = null;
  private audio: AudioContext | null = null;
  private destination: MediaStreamAudioDestinationNode | null = null;
  private mediaRecorder: MediaRecorder | null = null;
  private ownedStreams: MediaStream[] = [];
  private frame: number | null = null;
  private lastDraw = Number.NEGATIVE_INFINITY;
  private started = false;
  private stopped = false;
  private finishing = false;
  private inputSealed = false;
  private finishTask: Promise<RecorderFinish> | null = null;
  private settleCollect: ((result: RecorderFinish) => void) | null = null;
  private inputTimer: ReturnType<typeof setTimeout> | undefined;
  private failure: 'upload' | 'recorder' | undefined;
  private hasMedia = false;

  constructor(private readonly options: StageRecorderOptions) {
    this.upload = new ChunkUpload(
      options.broadcastId,
      options.token,
      options.send ?? postChunk,
      () => this.overflow(),
    );
    // Native frame APIs require Window as their receiver when retained on a service.
    this.requestFrame = options.requestFrame ?? requestAnimationFrame.bind(globalThis);
    this.cancelFrame = options.cancelFrame ?? cancelAnimationFrame.bind(globalThis);
    this.createCanvas = options.createCanvas ?? (() => document.createElement('canvas'));
    this.createAudioContext = options.createAudioContext ?? (() => new AudioContext());
    this.createRecorder =
      options.createRecorder ??
      ((stream, recorderOptions) => new MediaRecorder(stream, recorderOptions));
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    try {
      const canvas = this.createCanvas();
      canvas.width = STAGE_WIDTH;
      canvas.height = STAGE_HEIGHT;
      this.canvas = canvas;
      const drawing = canvas.getContext('2d');
      if (!drawing) throw new Error('Unable to draw the stage.');
      this.drawing = drawing;
      const audio = this.createAudioContext();
      this.audio = audio;
      this.destination = audio.createMediaStreamDestination();
      void audio.resume().catch(() => undefined);
      this.rebuildMix(true);
      const capture = canvas.captureStream(STAGE_FPS);
      this.ownedStreams.push(capture);
      const video = capture.getVideoTracks()[0];
      const mixedStream = this.destination.stream;
      this.ownedStreams.push(mixedStream);
      const mixed = mixedStream.getAudioTracks()[0];
      if (!video || !mixed) throw new Error('Unable to capture the stage.');
      const output = new MediaStream([video, mixed]);
      this.ownedStreams.push(output);
      const recorder = this.createRecorder(output, {
        mimeType: RECORDER_MIME,
        videoBitsPerSecond: VIDEO_BITS_PER_SECOND,
      });
      this.mediaRecorder = recorder;
      recorder.onerror = () => this.fail('recorder');
      recorder.onstop = () => this.fail('recorder');
      recorder.ondataavailable = (event) => {
        if (this.stopped || this.inputSealed) return;
        if (event.data.size === 0) return;
        this.hasMedia = true;
        this.watchInput();
        this.upload.push(event.data);
      };
      recorder.start(CHUNK_INTERVAL_MS);
      this.watchInput();
      this.frame = this.requestFrame(this.draw);
    } catch (error) {
      this.stop();
      throw error;
    }
  }

  update(sources: readonly StageSource[]): void {
    this.sources = [...sources];
    if (this.audio && !this.stopped && !this.finishing) this.rebuildMix(false);
  }

  /**
   * Waits for the recorder's final blob and for every accepted chunk upload.
   * Owned tracks stay live until that drain ends. Leave and unload use stop() instead.
   */
  finish(): Promise<RecorderFinish> {
    if (this.finishTask) return this.finishTask;
    if (this.stopped) return Promise.resolve({ ok: false, reason: 'aborted' });
    this.finishing = true;
    this.finishTask = this.runFinish();
    return this.finishTask;
  }

  /** Cancels the canvas frame, drops unsent chunks, and releases owned media immediately. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.inputTimer);
    const settle = this.settleCollect;
    this.settleCollect = null;
    try {
      if (this.frame !== null) this.cancelFrame(this.frame);
      this.frame = null;
      const recorder = this.mediaRecorder;
      this.mediaRecorder = null;
      if (recorder) {
        recorder.ondataavailable = null;
        recorder.onstop = null;
        recorder.onerror = null;
        if (recorder.state !== 'inactive') {
          try {
            recorder.stop();
          } catch {
            // Native failure must not prevent upload cancellation and track release.
          }
        }
      }
      this.upload.stop();
      this.disconnectMix();
    } finally {
      this.releaseOwnedMedia();
      settle?.({ ok: false, reason: 'aborted' });
    }
  }

  /**
   * Stops tracks this recorder created. Microphone and camera tracks borrowed from
   * stage members are not in these streams and stay live for the room.
   */
  private releaseOwnedMedia(): void {
    const streams = this.ownedStreams;
    this.ownedStreams = [];
    const released = new Set<MediaStreamTrack>();
    for (const stream of streams) {
      for (const track of stream.getTracks()) {
        if (released.has(track) || track.readyState === 'ended') continue;
        released.add(track);
        track.stop();
      }
    }
    const audio = this.audio;
    this.audio = null;
    this.destination = null;
    if (audio) void audio.close().catch(() => undefined);
    if (this.canvas) {
      this.canvas.width = 0;
      this.canvas.height = 0;
      this.canvas = null;
    }
    this.drawing = null;
  }

  private overflow(): void {
    this.fail('upload');
  }

  private watchInput(): void {
    clearTimeout(this.inputTimer);
    if (this.finishing || this.stopped) return;
    this.inputTimer = setTimeout(() => this.fail('recorder'), RECORDER_INPUT_MS);
  }

  private fail(reason: 'upload' | 'recorder'): void {
    if (this.stopped) return;
    this.failure = reason;
    this.stop();
    if (!this.finishing) this.options.onCap();
  }

  private async runFinish(): Promise<RecorderFinish> {
    const collected = await this.collectFinal();
    if (this.stopped) return { ok: false, reason: this.failure ?? 'aborted' };
    if (!collected.ok) {
      this.stop();
      return collected;
    }
    const drained = await this.upload.drain(RECORDER_FINISH_MS);
    if (!drained.ok && drained.reason !== 'aborted') {
      if (!this.stopped) this.stop();
      return { ok: false, reason: drained.reason };
    }
    if (this.stopped) return { ok: false, reason: this.failure ?? 'aborted' };
    this.stop();
    return { ok: true };
  }

  /** The final dataavailable event is delivered before the recorder's stop event. */
  private collectFinal(): Promise<RecorderFinish> {
    clearTimeout(this.inputTimer);
    if (this.stopped) return Promise.resolve({ ok: false, reason: 'aborted' });
    if (this.frame !== null) {
      this.cancelFrame(this.frame);
      this.frame = null;
    }
    const recorder = this.mediaRecorder;
    if (!recorder || recorder.state === 'inactive') {
      this.inputSealed = true;
      this.upload.seal();
      return Promise.resolve({ ok: true });
    }
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: RecorderFinish) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.settleCollect = null;
        resolve(result);
      };
      this.settleCollect = finish;
      const timer = setTimeout(() => {
        this.inputSealed = true;
        this.upload.seal();
        const pending = this.mediaRecorder;
        if (pending) {
          pending.ondataavailable = null;
          pending.onstop = null;
        }
        finish({ ok: false, reason: 'timeout' });
      }, RECORDER_FINISH_MS);
      recorder.onstop = () => {
        this.inputSealed = true;
        this.upload.seal();
        finish(this.hasMedia ? { ok: true } : { ok: false, reason: 'recorder' });
      };
      try {
        recorder.stop();
      } catch {
        this.inputSealed = true;
        this.upload.seal();
        finish({ ok: false, reason: 'aborted' });
      }
    });
  }

  private disconnectMix(): void {
    for (const node of this.nodes) node.disconnect();
    this.nodes = [];
    this.audible = [];
  }

  private rebuildMix(force: boolean): void {
    const next = audibleTracks(this.sources);
    if (
      !force &&
      next.length === this.audible.length &&
      next.every((track, index) => track === this.audible[index])
    )
      return;
    this.disconnectMix();
    this.audible = next;
    const audio = this.audio;
    const destination = this.destination;
    if (!audio || !destination) return;
    for (const track of next) {
      const node = audio.createMediaStreamSource(new MediaStream([track]));
      node.connect(destination);
      this.nodes.push(node);
    }
  }

  private readonly draw = (now: number): void => {
    if (this.stopped || this.finishing) return;
    this.frame = null;
    if (now - this.lastDraw >= FRAME_MS) {
      this.lastDraw = Number.isFinite(this.lastDraw)
        ? now - ((now - this.lastDraw) % FRAME_MS)
        : now;
      this.paint();
    }
    if (!this.stopped && !this.finishing) this.frame = this.requestFrame(this.draw);
  };

  private paint(): void {
    const drawing = this.drawing;
    if (!drawing) return;
    drawing.fillStyle = STAGE_BACKGROUND;
    drawing.fillRect(0, 0, STAGE_WIDTH, STAGE_HEIGHT);
    const sharingIndex = this.sources.findIndex((source) => source.screenSharing);
    for (const placed of placeStageFrames(this.sources.length, sharingIndex)) {
      const video = this.sources[placed.index]?.video;
      if (!video || video.readyState < HAVE_CURRENT_DATA) continue;
      drawing.drawImage(video, placed.rect.x, placed.rect.y, placed.rect.width, placed.rect.height);
    }
  }
}
