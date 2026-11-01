import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalMedia } from './local-media';

function track(kind: 'audio' | 'video') {
  const captured = { kind, enabled: true, readyState: 'live', onended: null,
    stop: vi.fn(() => { captured.readyState = 'ended'; }) };
  return captured as unknown as MediaStreamTrack;
}
function stream(tracks: MediaStreamTrack[]): MediaStream {
  return { getTracks: () => tracks, getVideoTracks: () => tracks.filter((t) => t.kind === 'video'),
    getAudioTracks: () => tracks.filter((t) => t.kind === 'audio') } as MediaStream;
}
const display = vi.fn<() => Promise<MediaStream>>();
let camera: MediaStreamTrack;
let microphone: MediaStreamTrack;
let media: LocalMedia;

beforeEach(() => {
  media = new LocalMedia();
  camera = track('video');
  microphone = track('audio');
  display.mockReset();
  vi.stubGlobal('navigator', { mediaDevices: {
    getUserMedia: vi.fn(async (constraints: MediaStreamConstraints) => stream([constraints.video ? camera : microphone])),
    getDisplayMedia: display,
  } });
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.stubGlobal('AudioContext', class {
    createMediaStreamSource() { return { connect: vi.fn(), disconnect: vi.fn() }; }
    createAnalyser() { return { fftSize: 256, getFloatTimeDomainData: (samples: Float32Array) => samples.fill(0) }; }
    resume() { return Promise.resolve(); }
    close() { return Promise.resolve(); }
  });
});

afterEach(() => { media.stop(); vi.unstubAllGlobals(); });

async function prepare() {
  const video = { srcObject: null, play: async () => undefined } as unknown as HTMLVideoElement;
  await media.prepare(video, { cameraId: '', microphoneId: '' }, () => undefined);
}

describe('LocalMedia screen sharing', () => {
  it('captures video only, keeps the disabled camera live, and restores its preview after stopping', async () => {
    await prepare();
    media.applyFlags(false, true);
    const screen = track('video');
    display.mockResolvedValue(stream([screen]));
    expect(await media.startScreenShare()).toBe(screen);
    expect(display).toHaveBeenCalledWith({ video: true, audio: false });
    expect(media.previewStream()?.getVideoTracks()).toEqual([screen]);
    media.applyFlags(true, true);
    expect(screen.enabled).toBe(true);
    expect(camera.readyState).toBe('live');
    expect(camera.enabled).toBe(false);
    media.stopScreenShare();
    expect(screen.readyState).toBe('ended');
    expect(media.previewStream()?.getVideoTracks()).toEqual([camera]);
    expect(camera.enabled).toBe(false);
    expect(microphone.readyState).toBe('live');
  });

  it('stops a previous screen before requesting another and stops every owned track on leave', async () => {
    await prepare();
    const first = track('video');
    const second = track('video');
    display.mockResolvedValueOnce(stream([first])).mockImplementationOnce(async () => {
      expect(first.readyState).toBe('ended');
      return stream([second]);
    });
    await media.startScreenShare();
    first.onended = vi.fn();
    await media.startScreenShare();
    expect(first.onended).toBeNull();
    media.stop();
    expect([camera, microphone, first, second].every((t) => t.readyState === 'ended')).toBe(true);
    expect(media.screenTrack()).toBeNull();
    expect(media.previewStream()).toBeNull();
  });

  it('keeps the camera and microphone after picker cancellation', async () => {
    await prepare();
    display.mockRejectedValue(new DOMException('Cancelled', 'NotAllowedError'));
    await expect(media.startScreenShare()).rejects.toThrow('Cancelled');
    expect(media.screenTrack()).toBeNull();
    expect(media.cameraTrack()).toBe(camera);
    expect(media.microphoneTrack()).toBe(microphone);
  });

  it('stops capture that resolves after leave instead of retaining a late screen', async () => {
    let finish!: (value: MediaStream) => void;
    display.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const pending = media.startScreenShare();
    media.stop();
    const screen = track('video');
    finish(stream([screen]));
    await expect(pending).rejects.toThrow('ended before it could start');
    expect(screen.readyState).toBe('ended');
    expect(media.screenTrack()).toBeNull();
  });
});
