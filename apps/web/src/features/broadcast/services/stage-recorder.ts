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

export type BroadcastRecorder = {
  start(): void;
  update(sources: readonly StageSource[]): void;
  stop(): void;
};

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
  /** The upload held 8 blobs, or a chunk was refused. The caller stops the broadcast. */
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
  private frame: number | null = null;
  private lastDraw = Number.NEGATIVE_INFINITY;
  private started = false;
  private stopped = false;

  constructor(private readonly options: StageRecorderOptions) {
    this.upload = new ChunkUpload(
      options.broadcastId,
      options.token,
      options.send ?? postChunk,
      () => this.overflow(),
    );
    this.requestFrame = options.requestFrame ?? requestAnimationFrame;
    this.cancelFrame = options.cancelFrame ?? cancelAnimationFrame;
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
      const drawing = canvas.getContext('2d');
      if (!drawing) throw new Error('Unable to draw the stage.');
      this.canvas = canvas;
      this.drawing = drawing;
      const audio = this.createAudioContext();
      this.audio = audio;
      this.destination = audio.createMediaStreamDestination();
      void audio.resume().catch(() => undefined);
      this.rebuildMix(true);
      const video = canvas.captureStream(STAGE_FPS).getVideoTracks()[0];
      const mixed = this.destination.stream.getAudioTracks()[0];
      if (!video || !mixed) throw new Error('Unable to capture the stage.');
      const recorder = this.createRecorder(new MediaStream([video, mixed]), {
        mimeType: RECORDER_MIME,
        videoBitsPerSecond: VIDEO_BITS_PER_SECOND,
      });
      recorder.ondataavailable = (event) => {
        if (!this.stopped) this.upload.push(event.data);
      };
      recorder.start(CHUNK_INTERVAL_MS);
      this.mediaRecorder = recorder;
      this.frame = this.requestFrame(this.draw);
    } catch (error) {
      this.stop();
      throw error;
    }
  }

  update(sources: readonly StageSource[]): void {
    this.sources = [...sources];
    if (this.audio && !this.stopped) this.rebuildMix(false);
  }

  /** Cancels the canvas frame, stops the recorder, drops unsent chunks, and closes the mix. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.frame !== null) this.cancelFrame(this.frame);
    this.frame = null;
    const recorder = this.mediaRecorder;
    this.mediaRecorder = null;
    if (recorder && recorder.state !== 'inactive') {
      recorder.ondataavailable = null;
      recorder.stop();
    }
    this.upload.stop();
    this.disconnectMix();
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
    this.stop();
    this.options.onCap();
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
    if (this.stopped) return;
    this.frame = null;
    if (now - this.lastDraw >= FRAME_MS) {
      this.lastDraw = Number.isFinite(this.lastDraw)
        ? now - ((now - this.lastDraw) % FRAME_MS)
        : now;
      this.paint();
    }
    if (!this.stopped) this.frame = this.requestFrame(this.draw);
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
