import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  StageRecorder,
  RECORDER_FINISH_MS,
  type StageSource,
  VIDEO_BITS_PER_SECOND,
  RECORDER_MIME,
} from './stage-recorder';
import type { ChunkRequest } from './chunk-upload';

type Draw = { image: HTMLVideoElement; x: number; y: number; width: number; height: number };
type MixNode = { disconnect: ReturnType<typeof vi.fn>; track: MediaStreamTrack };

function video(): HTMLVideoElement {
  return { readyState: 2 } as HTMLVideoElement;
}

function track(): MediaStreamTrack & { stop: ReturnType<typeof vi.fn> } {
  const media = {
    readyState: 'live' as MediaStreamTrackState,
    stop: vi.fn(() => {
      media.readyState = 'ended';
    }),
  };
  return media as unknown as MediaStreamTrack & { stop: ReturnType<typeof vi.fn> };
}

function source(patch: Partial<StageSource> = {}): StageSource {
  return {
    id: 'person',
    video: video(),
    audioTrack: null,
    muted: false,
    screenSharing: false,
    ...patch,
  };
}

describe('StageRecorder', () => {
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  let draws: Draw[];
  let fills: number[][];
  let fillStyle: string;
  let captureRate: number;
  let canvas: HTMLCanvasElement;
  let nodes: MixNode[];
  let closeContext: ReturnType<typeof vi.fn<() => Promise<void>>>;
  let recorders: FakeRecorder[];
  let captureTrack: ReturnType<typeof track>;
  let mixedTrack: ReturnType<typeof track>;
  let videoTracks: MediaStreamTrack[];
  let audioTracks: MediaStreamTrack[];

  class FakeStream {
    constructor(readonly tracks: MediaStreamTrack[]) {}
    getTracks(): MediaStreamTrack[] {
      return [...this.tracks];
    }
    getAudioTracks(): MediaStreamTrack[] {
      return [...this.tracks];
    }
    getVideoTracks(): MediaStreamTrack[] {
      return [...this.tracks];
    }
  }

  class FakeRecorder {
    state: RecordingState = 'inactive';
    ondataavailable: ((event: BlobEvent) => void) | null = null;
    onstop: (() => void) | null = null;
    timeslice: number | undefined;
    constructor(
      readonly stream: MediaStream,
      readonly options: MediaRecorderOptions,
    ) {
      recorders.push(this);
    }
    finalBlob: Blob | null = null;
    start(timeslice?: number): void {
      this.state = 'recording';
      this.timeslice = timeslice;
    }
    /** Queues the final blob, then the stop event, matching the recorder algorithm. */
    stop(): void {
      if (this.state === 'inactive') return;
      this.state = 'inactive';
      const blob = this.finalBlob;
      queueMicrotask(() => {
        if (blob && blob.size > 0) this.ondataavailable?.({ data: blob } as BlobEvent);
        this.onstop?.();
      });
    }
    emit(data: Blob): void {
      this.ondataavailable?.({ data } as BlobEvent);
    }
  }

  function requestFrame(callback: FrameRequestCallback): number {
    nextFrame += 1;
    frames.set(nextFrame, callback);
    return nextFrame;
  }

  const cancelFrame = vi.fn((handle: number) => {
    frames.delete(handle);
  });

  function tick(now: number): void {
    const handle = Math.max(...frames.keys());
    const callback = frames.get(handle);
    if (!callback) throw new Error('No canvas frame is scheduled.');
    frames.delete(handle);
    callback(now);
  }

  function mediaStream(tracks: readonly MediaStreamTrack[]): MediaStream {
    return {
      getTracks: () => [...tracks],
      getAudioTracks: () => [...tracks],
      getVideoTracks: () => [...tracks],
    } as unknown as MediaStream;
  }

  function recorder(
    send: (request: ChunkRequest) => Promise<number>,
    onCap = vi.fn(),
    patch: Partial<ConstructorParameters<typeof StageRecorder>[0]> = {},
  ): StageRecorder {
    return new StageRecorder({
      broadcastId: 'broadcast-1',
      token: 'token',
      onCap,
      send,
      createCanvas: () => canvas,
      createAudioContext: () =>
        ({
          resume: () => Promise.resolve(),
          close: closeContext,
          createMediaStreamDestination: () => ({
            stream: mediaStream(audioTracks),
          }),
          createMediaStreamSource: (stream: MediaStream) => {
            const node = {
              disconnect: vi.fn(),
              connect: vi.fn(),
              track: (stream as unknown as FakeStream).tracks[0]!,
            };
            nodes.push(node);
            return node as unknown as MediaStreamAudioSourceNode;
          },
        }) as unknown as AudioContext,
      createRecorder: (stream, options) =>
        new FakeRecorder(stream, options) as unknown as MediaRecorder,
      requestFrame,
      cancelFrame,
      ...patch,
    });
  }

  beforeEach(() => {
    frames.clear();
    nextFrame = 0;
    draws = [];
    fills = [];
    fillStyle = '';
    captureRate = -1;
    nodes = [];
    recorders = [];
    captureTrack = track();
    mixedTrack = track();
    videoTracks = [captureTrack];
    audioTracks = [mixedTrack];
    closeContext = vi.fn(() => Promise.resolve());
    cancelFrame.mockClear();
    canvas = {
      width: 0,
      height: 0,
      getContext: () =>
        ({
          get fillStyle() {
            return fillStyle;
          },
          set fillStyle(value: string) {
            fillStyle = value;
          },
          fillRect: (...args: number[]) => {
            fills.push(args);
          },
          drawImage: (
            image: HTMLVideoElement,
            x: number,
            y: number,
            width: number,
            height: number,
          ) => {
            draws.push({ image, x, y, width, height });
          },
        }) as unknown as CanvasRenderingContext2D,
      captureStream: (rate?: number) => {
        captureRate = rate ?? 0;
        return mediaStream(videoTracks);
      },
    } as unknown as HTMLCanvasElement;
    vi.stubGlobal('MediaStream', FakeStream);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('draws a 2×2 stage and leaves the empty cell as the background', () => {
    const people = [
      source({ id: 'a' }),
      source({ id: 'b' }),
      source({ id: 'c' }),
      source({ id: 'd' }),
    ];
    const stage = recorder(() => Promise.resolve(204));
    stage.update(people.slice(0, 3));
    stage.start();
    tick(0);
    expect(canvas.width).toBe(1280);
    expect(canvas.height).toBe(720);
    expect(captureRate).toBe(24);
    expect(recorders[0]?.options).toEqual({
      mimeType: RECORDER_MIME,
      videoBitsPerSecond: VIDEO_BITS_PER_SECOND,
    });
    expect(recorders[0]?.timeslice).toBe(1000);
    expect(fillStyle).toBe('#0d1113');
    expect(fills).toContainEqual([0, 0, 1280, 720]);
    expect(draws).toEqual([
      { image: people[0]!.video, x: 0, y: 0, width: 640, height: 360 },
      { image: people[1]!.video, x: 640, y: 0, width: 640, height: 360 },
      { image: people[2]!.video, x: 0, y: 360, width: 640, height: 360 },
    ]);
    stage.update(people);
    tick(1000 / 24);
    expect(draws.at(-4)).toEqual({ image: people[0]!.video, x: 0, y: 0, width: 640, height: 360 });
    expect(draws.at(-1)).toEqual({
      image: people[3]!.video,
      x: 640,
      y: 360,
      width: 640,
      height: 360,
    });
    stage.stop();
  });

  it('draws one stage member full frame and two stage members as columns', () => {
    const alone = source({ id: 'only' });
    const stage = recorder(() => Promise.resolve(204));
    stage.update([alone]);
    stage.start();
    tick(0);
    expect(draws).toEqual([{ image: alone.video, x: 0, y: 0, width: 1280, height: 720 }]);
    const pair = [source({ id: 'a' }), source({ id: 'b' })];
    stage.update(pair);
    tick(1000 / 24);
    expect(draws.slice(-2)).toEqual([
      { image: pair[0]!.video, x: 0, y: 0, width: 640, height: 720 },
      { image: pair[1]!.video, x: 640, y: 0, width: 640, height: 720 },
    ]);
    stage.stop();
  });

  it('fills the canvas with the screen share and does not draw the other stage videos', () => {
    const people = [
      source({ id: 'a' }),
      source({ id: 'shared', screenSharing: true }),
      source({ id: 'c' }),
    ];
    const stage = recorder(() => Promise.resolve(204));
    stage.update(people);
    stage.start();
    tick(0);
    expect(draws).toEqual([{ image: people[1]!.video, x: 0, y: 0, width: 1280, height: 720 }]);
    stage.stop();
  });

  it('uploads the first blob as sequence 0 and holds the next until 204', async () => {
    const sent: ChunkRequest[] = [];
    let release: (status: number) => void = () => undefined;
    const stage = recorder((request) => {
      sent.push(request);
      if (request.sequence === 0)
        return new Promise<number>((resolve) => {
          release = resolve;
        });
      return Promise.resolve(204);
    });
    stage.start();
    const header = new Blob(['header']);
    const next = new Blob(['next']);
    recorders[0]?.emit(header);
    recorders[0]?.emit(next);
    await Promise.resolve();
    expect(sent.map((request) => request.sequence)).toEqual([0]);
    expect(sent[0]?.body).toBe(header);
    release(204);
    await vi.waitFor(() => expect(sent.map((request) => request.sequence)).toEqual([0, 1]));
    expect(sent[1]?.body).toBe(next);
    stage.stop();
  });

  it('stops the recorder when a ninth blob arrives before eight uploads finish', async () => {
    const sent: number[] = [];
    const onCap = vi.fn();
    let release: (status: number) => void = () => undefined;
    const stage = recorder((request) => {
      sent.push(request.sequence);
      return new Promise<number>((resolve) => {
        release = resolve;
      });
    }, onCap);
    const mic = track();
    stage.update([source({ audioTrack: mic })]);
    stage.start();
    expect(nodes).toHaveLength(1);
    for (let index = 0; index < 8; index += 1) recorders[0]?.emit(new Blob([String(index)]));
    await Promise.resolve();
    expect(sent).toEqual([0]);
    expect(onCap).not.toHaveBeenCalled();
    recorders[0]?.emit(new Blob(['ninth']));
    await vi.waitFor(() => expect(onCap).toHaveBeenCalledOnce());
    expect(recorders[0]?.state).toBe('inactive');
    expect(cancelFrame).toHaveBeenCalled();
    expect(nodes[0]?.disconnect).toHaveBeenCalled();
    expect(closeContext).toHaveBeenCalled();
    expect(canvas.width).toBe(0);
    release(204);
    await Promise.resolve();
    expect(sent).toEqual([0]);
  });

  it('rebuilds the mix and drops an unsent blob when recording stops', async () => {
    const sent: ChunkRequest[] = [];
    let release: (status: number) => void = () => undefined;
    const stage = recorder((request) => {
      sent.push(request);
      return new Promise<number>((resolve) => {
        release = resolve;
      });
    });
    const first = track();
    const second = track();
    stage.update([source({ id: 'a', audioTrack: first }), source({ id: 'b', audioTrack: second })]);
    stage.start();
    tick(0);
    expect(frames.size).toBe(1);
    const mixed = nodes.slice();
    stage.update([
      source({ id: 'a', audioTrack: first, muted: true }),
      source({ id: 'b', audioTrack: second }),
    ]);
    expect(mixed[0]?.disconnect).toHaveBeenCalledOnce();
    expect(mixed[1]?.disconnect).toHaveBeenCalledOnce();
    expect(nodes).toHaveLength(3);
    expect(nodes[2]?.track).toBe(second);
    recorders[0]?.emit(new Blob(['header']));
    recorders[0]?.emit(new Blob(['queued']));
    await Promise.resolve();
    const tail = new Blob(['tail']);
    if (recorders[0]) recorders[0].finalBlob = tail;
    stage.stop();
    await Promise.resolve();
    expect(sent.some((request) => request.body === tail)).toBe(false);
    expect(cancelFrame).toHaveBeenCalled();
    expect(frames.size).toBe(0);
    expect(recorders[0]?.state).toBe('inactive');
    expect(sent[0]?.signal.aborted).toBe(true);
    expect(nodes[2]?.disconnect).toHaveBeenCalled();
    expect(closeContext).toHaveBeenCalledOnce();
    expect(canvas.width).toBe(0);
    release(204);
    await Promise.resolve();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.sequence).toBe(0);
  });

  it('ends owned capture and mix tracks once and leaves borrowed stage tracks live', () => {
    const mic = track();
    const stage = recorder(() => Promise.resolve(204));
    stage.update([source({ audioTrack: mic })]);
    stage.start();
    expect(nodes[0]?.track).toBe(mic);
    stage.stop();
    stage.stop();
    expect(captureTrack.stop).toHaveBeenCalledOnce();
    expect(mixedTrack.stop).toHaveBeenCalledOnce();
    expect(captureTrack.readyState).toBe('ended');
    expect(mixedTrack.readyState).toBe('ended');
    expect(mic.stop).not.toHaveBeenCalled();
    expect(mic.readyState).toBe('live');
  });

  it('zeroes the canvas when the drawing context is missing', () => {
    const stage = recorder(() => Promise.resolve(204));
    canvas.getContext = () => null;
    expect(() => stage.start()).toThrow('Unable to draw the stage.');
    expect(canvas.width).toBe(0);
    expect(captureTrack.stop).not.toHaveBeenCalled();
    expect(mixedTrack.stop).not.toHaveBeenCalled();
    expect(closeContext).not.toHaveBeenCalled();
    stage.stop();
  });

  it('zeroes the canvas when the audio context cannot be created', () => {
    const stage = recorder(() => Promise.resolve(204), vi.fn(), {
      createAudioContext: () => {
        throw new Error('no audio');
      },
    });
    expect(() => stage.start()).toThrow('no audio');
    expect(canvas.width).toBe(0);
    expect(captureTrack.stop).not.toHaveBeenCalled();
    expect(mixedTrack.stop).not.toHaveBeenCalled();
    expect(closeContext).not.toHaveBeenCalled();
  });

  it('releases the mix track when the canvas capture has no video track', () => {
    videoTracks = [];
    const stage = recorder(() => Promise.resolve(204));
    expect(() => stage.start()).toThrow('Unable to capture the stage.');
    expect(mixedTrack.readyState).toBe('ended');
    expect(captureTrack.stop).not.toHaveBeenCalled();
    expect(canvas.width).toBe(0);
    expect(closeContext).toHaveBeenCalledOnce();
    stage.stop();
    expect(mixedTrack.stop).toHaveBeenCalledOnce();
  });

  it('releases the capture track when the mix has no audio track', () => {
    audioTracks = [];
    const stage = recorder(() => Promise.resolve(204));
    expect(() => stage.start()).toThrow('Unable to capture the stage.');
    expect(captureTrack.readyState).toBe('ended');
    expect(mixedTrack.stop).not.toHaveBeenCalled();
    expect(canvas.width).toBe(0);
    expect(closeContext).toHaveBeenCalledOnce();
    stage.stop();
    expect(captureTrack.stop).toHaveBeenCalledOnce();
  });

  it('releases owned tracks when the recorder cannot be constructed or started', () => {
    const cannotConstruct = recorder(() => Promise.resolve(204), vi.fn(), {
      createRecorder: () => {
        throw new Error('no encoder');
      },
    });
    expect(() => cannotConstruct.start()).toThrow('no encoder');
    expect(captureTrack.readyState).toBe('ended');
    expect(mixedTrack.readyState).toBe('ended');
    expect(closeContext).toHaveBeenCalledOnce();
    expect(canvas.width).toBe(0);
    cannotConstruct.stop();
    expect(captureTrack.stop).toHaveBeenCalledOnce();
    expect(mixedTrack.stop).toHaveBeenCalledOnce();

    captureTrack = track();
    mixedTrack = track();
    videoTracks = [captureTrack];
    audioTracks = [mixedTrack];
    closeContext.mockClear();
    const cannotStart = recorder(() => Promise.resolve(204), vi.fn(), {
      createRecorder: (stream, options) => {
        const created = new FakeRecorder(stream, options);
        created.start = () => {
          created.state = 'recording';
          throw new Error('start failed');
        };
        return created as unknown as MediaRecorder;
      },
    });
    expect(() => cannotStart.start()).toThrow('start failed');
    expect(recorders[0]?.state).toBe('inactive');
    expect(captureTrack.readyState).toBe('ended');
    expect(mixedTrack.readyState).toBe('ended');
    expect(closeContext).toHaveBeenCalledOnce();
    expect(canvas.width).toBe(0);
  });

  it('uploads the final blob after a pending chunk, then releases owned tracks', async () => {
    const sent: ChunkRequest[] = [];
    let release: (status: number) => void = () => undefined;
    const mic = track();
    const stage = recorder((request) => {
      sent.push(request);
      return new Promise<number>((resolve) => {
        release = resolve;
      });
    });
    stage.update([source({ audioTrack: mic })]);
    stage.start();
    const header = new Blob(['header']);
    const finalBlob = new Blob(['final']);
    recorders[0]?.emit(header);
    await Promise.resolve();
    expect(sent.map((request) => request.body)).toEqual([header]);
    if (recorders[0]) recorders[0].finalBlob = finalBlob;
    const finishing = stage.finish();
    stage.update([source({ id: 'late', audioTrack: track() })]);
    expect(nodes).toHaveLength(1);
    await Promise.resolve();
    await Promise.resolve();
    expect(sent.map((request) => request.body)).toEqual([header]);
    expect(captureTrack.readyState).toBe('live');
    expect(mixedTrack.readyState).toBe('live');
    release(204);
    await vi.waitFor(() =>
      expect(sent.map((request) => request.body)).toEqual([header, finalBlob]),
    );
    expect(captureTrack.readyState).toBe('live');
    release(204);
    await expect(finishing).resolves.toEqual({ ok: true });
    expect(captureTrack.readyState).toBe('ended');
    expect(mixedTrack.readyState).toBe('ended');
    expect(mic.stop).not.toHaveBeenCalled();
    expect(mic.readyState).toBe('live');
    recorders[0]?.emit(new Blob(['after-stop']));
    expect(sent).toHaveLength(2);
  });

  it('uploads the only blob when the recording is shorter than one timeslice', async () => {
    const sent: Blob[] = [];
    const stage = recorder((request) => {
      sent.push(request.body);
      return Promise.resolve(204);
    });
    stage.start();
    expect(sent).toEqual([]);
    const only = new Blob(['short']);
    if (recorders[0]) recorders[0].finalBlob = only;
    await expect(stage.finish()).resolves.toEqual({ ok: true });
    expect(sent).toEqual([only]);
    expect(captureTrack.readyState).toBe('ended');
    expect(mixedTrack.readyState).toBe('ended');
  });

  it('fails a hung upload and still releases owned tracks', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let signal: AbortSignal | undefined;
      const stage = recorder((request) => {
        signal = request.signal;
        return new Promise<number>(() => undefined);
      });
      stage.start();
      recorders[0]?.emit(new Blob(['header']));
      await Promise.resolve();
      if (recorders[0]) recorders[0].finalBlob = new Blob(['final']);
      const finishing = stage.finish();
      await Promise.resolve();
      await Promise.resolve();
      expect(captureTrack.readyState).toBe('live');
      await vi.advanceTimersByTimeAsync(RECORDER_FINISH_MS);
      await expect(finishing).resolves.toEqual({ ok: false, reason: 'timeout' });
      expect(signal?.aborted).toBe(true);
      expect(captureTrack.readyState).toBe('ended');
      expect(mixedTrack.readyState).toBe('ended');
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails when the recorder never delivers its final stop event', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const stage = recorder(() => Promise.resolve(204), vi.fn(), {
        createRecorder: (stream, options) => {
          const created = new FakeRecorder(stream, options);
          created.stop = () => {
            created.state = 'inactive';
          };
          return created as unknown as MediaRecorder;
        },
      });
      stage.start();
      const finishing = stage.finish();
      await vi.advanceTimersByTimeAsync(RECORDER_FINISH_MS);
      await expect(finishing).resolves.toEqual({ ok: false, reason: 'timeout' });
      expect(captureTrack.readyState).toBe('ended');
      expect(mixedTrack.readyState).toBe('ended');
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts a finish without waiting for the upload or the final blob', async () => {
    const sent: Blob[] = [];
    const stage = recorder((request) => {
      sent.push(request.body);
      return new Promise<number>(() => undefined);
    });
    stage.start();
    const header = new Blob(['header']);
    const tail = new Blob(['tail']);
    recorders[0]?.emit(header);
    await Promise.resolve();
    if (recorders[0]) recorders[0].finalBlob = tail;
    const finishing = stage.finish();
    stage.stop();
    await expect(finishing).resolves.toEqual({ ok: false, reason: 'aborted' });
    await Promise.resolve();
    expect(sent).toEqual([header]);
    expect(captureTrack.readyState).toBe('ended');
    expect(mixedTrack.readyState).toBe('ended');
  });
});
