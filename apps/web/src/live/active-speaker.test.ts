import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActiveSpeaker } from './active-speaker';

const levels = new Map<MediaStreamTrack, number>();
const frames = new Map<number, FrameRequestCallback>();
const sources: { disconnect: ReturnType<typeof vi.fn> }[] = [];
const analysers: { disconnect: ReturnType<typeof vi.fn> }[] = [];
const closeContext = vi.fn(() => Promise.resolve());
let sequence = 0;

function track(): MediaStreamTrack {
  return { enabled: true, readyState: 'live' } as MediaStreamTrack;
}

function tick(now: number): void {
  const entry = frames.entries().next().value;
  if (!entry) throw new Error('No sample frame scheduled.');
  frames.delete(entry[0]);
  entry[1](now);
}

beforeEach(() => {
  sequence = 0;
  levels.clear();
  frames.clear();
  sources.length = 0;
  analysers.length = 0;
  closeContext.mockClear();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++sequence, callback);
    return sequence;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  vi.stubGlobal('MediaStream', class {
    constructor(public tracks: MediaStreamTrack[]) {}
  });
  vi.stubGlobal('AudioContext', class {
    createMediaStreamSource(stream: { tracks: MediaStreamTrack[] }) {
      const source = { disconnect: vi.fn(), connect(analyser: { track?: MediaStreamTrack }) {
        analyser.track = stream.tracks[0];
      } };
      sources.push(source);
      return source;
    }
    createAnalyser() {
      const analyser = { fftSize: 0, track: undefined as MediaStreamTrack | undefined,
        disconnect: vi.fn(), getFloatTimeDomainData(samples: Float32Array) {
          samples.fill(this.track ? levels.get(this.track) ?? 0 : 0);
        } };
      analysers.push(analyser);
      return analyser;
    }
    resume() { return Promise.resolve(); }
    close = closeContext;
  });
});

afterEach(() => vi.unstubAllGlobals());

describe('ActiveSpeaker', () => {
  it('requires a continuous 300 ms lead, holds the current speaker during a challenge, and clears on silence', () => {
    const a = track();
    const b = track();
    const publish = vi.fn();
    const speaker = new ActiveSpeaker(publish);
    levels.set(a, 0.1);
    levels.set(b, 0.02);
    speaker.sync(new Map([['a', a], ['b', b]]));
    tick(0); tick(299);
    expect(publish).not.toHaveBeenCalled();
    tick(300);
    expect(publish.mock.calls).toEqual([['a']]);
    levels.set(b, 0.2);
    tick(310); tick(609);
    expect(publish.mock.calls).toEqual([['a']]);
    tick(610);
    expect(publish.mock.calls).toEqual([['a'], ['b']]);
    levels.set(a, 0.3); tick(620);
    levels.set(a, 0.01); tick(700);
    levels.set(a, 0.3); tick(800); tick(1099);
    expect(publish).toHaveBeenLastCalledWith('b');
    tick(1100);
    expect(publish).toHaveBeenLastCalledWith('a');
    levels.set(a, 0.079); levels.set(b, 0.079); tick(1110);
    expect(publish).toHaveBeenLastCalledWith(null);
    speaker.close();
  });

  it('ignores disabled and ended tracks, replaces removed inputs, and releases owned resources without stopping media', () => {
    const a = track();
    const b = track();
    const publish = vi.fn();
    const speaker = new ActiveSpeaker(publish);
    levels.set(a, 0.2);
    a.enabled = false;
    speaker.sync(new Map([['a', a]]));
    tick(0); tick(300);
    expect(publish).not.toHaveBeenCalled();
    a.enabled = true;
    tick(310); tick(610);
    expect(publish).toHaveBeenLastCalledWith('a');
    speaker.sync(new Map([['a', a]]));
    expect(sources).toHaveLength(1);
    levels.set(b, 0.3);
    speaker.sync(new Map([['b', b]]));
    expect(publish).toHaveBeenLastCalledWith(null);
    expect(sources[0]?.disconnect).toHaveBeenCalledOnce();
    tick(620); tick(920);
    expect(publish).toHaveBeenLastCalledWith('b');
    Object.defineProperty(b, 'readyState', { value: 'ended' });
    tick(930);
    expect(publish).toHaveBeenLastCalledWith(null);
    speaker.close(); speaker.close();
    expect(frames.size).toBe(0);
    expect(closeContext).toHaveBeenCalledOnce();
    for (const node of [...sources, ...analysers]) expect(node.disconnect).toHaveBeenCalledOnce();
    expect(a.readyState).toBe('live');
  });
});
