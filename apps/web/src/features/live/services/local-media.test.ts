import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalMedia } from './local-media';
import { selectAudioOutput } from './output-route';

function track(kind: 'audio' | 'video') {
  const captured = {
    kind,
    enabled: true,
    readyState: 'live',
    onended: null,
    stop: vi.fn(() => {
      captured.readyState = 'ended';
    }),
  };
  return captured as unknown as MediaStreamTrack;
}
function stream(tracks: MediaStreamTrack[]): MediaStream {
  return {
    getTracks: () => tracks,
    getVideoTracks: () => tracks.filter((t) => t.kind === 'video'),
    getAudioTracks: () => tracks.filter((t) => t.kind === 'audio'),
  } as MediaStream;
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
  vi.stubGlobal('navigator', {
    mediaDevices: {
      getUserMedia: vi.fn(async (constraints: MediaStreamConstraints) =>
        stream([constraints.video ? camera : microphone]),
      ),
      getDisplayMedia: display,
    },
  });
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn(() => 1),
  );
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.stubGlobal(
    'AudioContext',
    class {
      createMediaStreamSource() {
        return { connect: vi.fn(), disconnect: vi.fn() };
      }
      createAnalyser() {
        return { fftSize: 256, getFloatTimeDomainData: (samples: Float32Array) => samples.fill(0) };
      }
      resume() {
        return Promise.resolve();
      }
      close() {
        return Promise.resolve();
      }
    },
  );
});

afterEach(async () => {
  media.stop();
  vi.unstubAllGlobals();
  await selectAudioOutput('');
});

function preview() {
  return {
    srcObject: null as MediaStream | null,
    pause: vi.fn(),
    play: vi.fn(async () => undefined),
  } as unknown as HTMLVideoElement & { pause: ReturnType<typeof vi.fn> };
}
async function prepare() {
  await media.prepare(preview(), { cameraId: '', microphoneId: '' });
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
    display.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const pending = media.startScreenShare();
    media.stop();
    const screen = track('video');
    finish(stream([screen]));
    await expect(pending).rejects.toThrow('ended before it could start');
    expect(screen.readyState).toBe('ended');
    expect(media.screenTrack()).toBeNull();
  });
});

describe('LocalMedia lobby capture', () => {
  it('retains disabled flags as each permission resolves and enables tracks only on a later patch', async () => {
    media.applyFlags(true, true);
    await prepare();
    expect(camera.enabled).toBe(false);
    expect(microphone.enabled).toBe(false);
    media.applyFlags(true, false);
    expect(camera.enabled).toBe(true);
    expect(microphone.enabled).toBe(false);
  });
  it('stops the meter and preview after join and keeps the call tracks live until leave', async () => {
    vi.useFakeTimers();
    try {
      const levels: number[] = [];
      const contexts: { close: ReturnType<typeof vi.fn> }[] = [];
      vi.stubGlobal(
        'AudioContext',
        class {
          close = vi.fn(() => Promise.resolve());
          constructor() {
            contexts.push(this);
          }
          createMediaStreamSource() {
            return { connect: vi.fn(), disconnect: vi.fn() };
          }
          createAnalyser() {
            return {
              fftSize: 256,
              getFloatTimeDomainData: (samples: Float32Array) => samples.fill(0.25),
            };
          }
          resume() {
            return Promise.resolve();
          }
        },
      );
      media.setLevelListener((level) => levels.push(level));
      const video = preview();
      await media.prepare(video, { cameraId: '', microphoneId: '' });
      expect(levels[0]).toBe(0);
      expect(levels.at(-1)).toBeGreaterThan(0);
      await vi.advanceTimersByTimeAsync(100);
      const published = levels.length;
      expect(published).toBeGreaterThan(1);
      media.releaseLobby();
      await vi.advanceTimersByTimeAsync(500);
      expect(levels).toHaveLength(published);
      expect(video.pause).toHaveBeenCalled();
      expect(video.srcObject).toBeNull();
      expect(contexts[0]?.close).toHaveBeenCalled();
      expect(media.ready).toBe(true);
      expect(camera.readyState).toBe('live');
      expect(microphone.readyState).toBe('live');
      media.stop();
      expect(camera.readyState).toBe('ended');
      expect(microphone.readyState).toBe('ended');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps capture ready when the selected speaker is rejected', async () => {
    const video = preview();
    const setSinkId = vi.fn(async (id: string) => {
      if (id === 'missing') throw new Error('device not found');
    });
    Object.assign(video, { setSinkId, sinkId: '' });
    await media.prepare(video, { cameraId: '', microphoneId: '' });
    const result = await media.setSpeaker('missing');
    expect(result.ok).toBe(false);
    expect(result.deviceId).toBe('');
    expect(result.message).toContain('device not found');
    expect(media.ready).toBe(true);
    expect(camera.readyState).toBe('live');
    expect(microphone.readyState).toBe('live');
  });

  it('stops a capture that resolves after leave or a newer device selection', async () => {
    const firstCamera = track('video');
    const secondCamera = track('video');
    let finishFirst: ((stream: MediaStream) => void) | undefined;
    let calls = 0;
    vi.mocked(navigator.mediaDevices.getUserMedia).mockImplementation(async (constraints) => {
      calls += 1;
      if (calls === 1) {
        return new Promise((resolve) => {
          finishFirst = resolve;
        });
      }
      return stream([constraints?.video ? secondCamera : microphone]);
    });
    const video = preview();
    const choices = { cameraId: '', microphoneId: '' };
    const first = media.prepare(video, choices);
    await vi.waitFor(() => expect(calls).toBe(1));
    const second = media.prepare(video, choices);
    finishFirst?.(stream([firstCamera]));
    await expect(first).resolves.toBe(false);
    await expect(second).resolves.toBe(true);
    expect(firstCamera.readyState).toBe('ended');
    expect(media.cameraTrack()).toBe(secondCamera);
    expect(media.microphoneTrack()).toBe(microphone);

    let finishLate: ((stream: MediaStream) => void) | undefined;
    const lateMic = track('audio');
    vi.mocked(navigator.mediaDevices.getUserMedia).mockImplementation(async (constraints) => {
      if (constraints?.video) return stream([camera]);
      return new Promise((resolve) => {
        finishLate = resolve;
      });
    });
    const pending = media.prepare(video, choices);
    await vi.waitFor(() => expect(finishLate).toBeTypeOf('function'));
    media.stop();
    finishLate?.(stream([lateMic]));
    await expect(pending).resolves.toBe(false);
    expect(lateMic.readyState).toBe('ended');
    expect(camera.readyState).toBe('ended');
    expect(media.ready).toBe(false);
    expect(media.previewStream()).toBeNull();
  });
});

describe('LocalMedia input replacement', () => {
  function deferStream() {
    let finish!: (value: MediaStream) => void;
    const promise = new Promise<MediaStream>((resolve) => {
      finish = resolve;
    });
    return { promise, finish: (value: MediaStream) => finish(value) };
  }

  it('replaces a microphone without requesting video or stopping the live inputs until commit', async () => {
    await prepare();
    media.applyFlags(true, false);
    const next = track('audio');
    const getUserMedia = vi.mocked(navigator.mediaDevices.getUserMedia);
    getUserMedia.mockClear();
    getUserMedia.mockResolvedValue(stream([next]));
    const held = await media.replaceInput('microphone', 'mic-2');
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: { deviceId: { exact: 'mic-2' } },
      video: false,
    });
    expect(held).toBe(next);
    expect(next.enabled).toBe(false);
    expect(camera.readyState).toBe('live');
    expect(microphone.readyState).toBe('live');
    expect(media.cameraTrack()).toBe(camera);
    expect(media.microphoneTrack()).toBe(microphone);
    media.commitInput('microphone', next);
    expect(microphone.readyState).toBe('ended');
    expect(media.microphoneTrack()).toBe(next);
    expect(media.cameraTrack()).toBe(camera);
    expect(camera.readyState).toBe('live');
  });

  it('aborts a held microphone and leaves the stored microphone in place', async () => {
    await prepare();
    const next = track('audio');
    vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValue(stream([next]));
    const held = await media.replaceInput('microphone', 'mic-2');
    expect(held).toBe(next);
    media.abortInput(next);
    expect(next.readyState).toBe('ended');
    expect(media.microphoneTrack()).toBe(microphone);
    expect(microphone.readyState).toBe('live');
    expect(media.cameraTrack()).toBe(camera);
  });

  it('keeps a live screen share in place while a camera replacement commits', async () => {
    await prepare();
    const screen = track('video');
    display.mockResolvedValue(stream([screen]));
    await media.startScreenShare();
    media.applyFlags(false, true);
    const next = track('video');
    const getUserMedia = vi.mocked(navigator.mediaDevices.getUserMedia);
    getUserMedia.mockClear();
    getUserMedia.mockResolvedValue(stream([next]));
    const held = await media.replaceInput('camera', '');
    expect(getUserMedia).toHaveBeenCalledWith({ video: true, audio: false });
    expect(held).toBe(next);
    expect(next.enabled).toBe(false);
    expect(screen.readyState).toBe('live');
    expect(screen.enabled).toBe(true);
    expect(media.screenTrack()).toBe(screen);
    expect(media.cameraTrack()).toBe(camera);
    expect(camera.readyState).toBe('live');
    media.commitInput('camera', next);
    expect(media.cameraTrack()).toBe(next);
    expect(camera.readyState).toBe('ended');
    expect(screen.readyState).toBe('live');
    expect(media.screenTrack()).toBe(screen);
    expect(microphone.readyState).toBe('live');
  });

  it('keeps the previous microphone when acquisition fails', async () => {
    await prepare();
    const getUserMedia = vi.mocked(navigator.mediaDevices.getUserMedia);
    getUserMedia.mockClear();
    getUserMedia.mockRejectedValueOnce(new Error('denied'));
    await expect(media.replaceInput('microphone', 'mic-2')).rejects.toThrow(
      'Unable to use your microphone. Allow microphone permission and check the selected device, then try again.',
    );
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: { deviceId: { exact: 'mic-2' } },
      video: false,
    });
    expect(media.microphoneTrack()).toBe(microphone);
    expect(media.cameraTrack()).toBe(camera);
    expect(microphone.readyState).toBe('live');
    expect(camera.readyState).toBe('live');

    getUserMedia.mockRejectedValueOnce(new Error('denied'));
    await expect(media.replaceInput('camera', 'cam-2')).rejects.toThrow(
      'Unable to use your camera. Allow camera permission and check the selected device, then try again.',
    );
    expect(getUserMedia).toHaveBeenLastCalledWith({
      video: { deviceId: { exact: 'cam-2' } },
      audio: false,
    });
    expect(microphone.readyState).toBe('live');
    expect(camera.readyState).toBe('live');
  });

  it('ends a stream that resolves after stop and does not open a queued replacement', async () => {
    await prepare();
    const firstCapture = deferStream();
    let calls = 0;
    vi.mocked(navigator.mediaDevices.getUserMedia).mockImplementation(() => {
      calls += 1;
      return firstCapture.promise;
    });
    const pending = media.replaceInput('microphone', 'late');
    await vi.waitFor(() => expect(calls).toBe(1));
    const queued = media.replaceInput('microphone', 'queued');
    media.stop();
    const late = track('audio');
    firstCapture.finish(stream([late]));
    await expect(pending).resolves.toBeNull();
    await expect(queued).resolves.toBeNull();
    expect(calls).toBe(1);
    expect(late.readyState).toBe('ended');
    expect(media.microphoneTrack()).toBeNull();
    expect(media.cameraTrack()).toBeNull();
    expect(media.ready).toBe(false);
  });

  it('ends a stream that resolves after a newer replacement and skips the queued call', async () => {
    await prepare();
    const firstCapture = deferStream();
    const newest = track('audio');
    const seen: MediaStreamConstraints[] = [];
    let calls = 0;
    vi.mocked(navigator.mediaDevices.getUserMedia).mockImplementation((constraints) => {
      calls += 1;
      seen.push(constraints ?? {});
      if (calls === 1) return firstCapture.promise;
      return Promise.resolve(stream([newest]));
    });
    const first = media.replaceInput('microphone', 'late');
    await vi.waitFor(() => expect(calls).toBe(1));
    const queued = media.replaceInput('microphone', 'queued');
    const current = media.replaceInput('microphone', 'current');
    const late = track('audio');
    firstCapture.finish(stream([late]));
    await expect(first).resolves.toBeNull();
    await expect(queued).resolves.toBeNull();
    await expect(current).resolves.toBe(newest);
    expect(calls).toBe(2);
    expect(seen).toEqual([
      { audio: { deviceId: { exact: 'late' } }, video: false },
      { audio: { deviceId: { exact: 'current' } }, video: false },
    ]);
    expect(late.readyState).toBe('ended');
    expect(newest.readyState).toBe('live');
    expect(media.microphoneTrack()).toBe(microphone);
    expect(microphone.readyState).toBe('live');
    expect(camera.readyState).toBe('live');
    media.commitInput('microphone', newest);
    expect(media.microphoneTrack()).toBe(newest);
    expect(microphone.readyState).toBe('ended');
  });

  it('stops a commit or abort for a track that is no longer held', async () => {
    await prepare();
    const held = track('audio');
    vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValue(stream([held]));
    await media.replaceInput('microphone', 'mic-2');
    const unexpected = track('video');
    media.commitInput('camera', unexpected);
    expect(unexpected.readyState).toBe('ended');
    expect(held.readyState).toBe('live');
    expect(media.cameraTrack()).toBe(camera);
    expect(media.microphoneTrack()).toBe(microphone);
    media.abortInput(unexpected);
    expect(held.readyState).toBe('live');
    media.commitInput('camera', held);
    expect(held.readyState).toBe('ended');
    expect(media.microphoneTrack()).toBe(microphone);
    expect(media.cameraTrack()).toBe(camera);
    expect(camera.readyState).toBe('live');
  });

  it('stops a held track, the screen share, and both stored inputs', async () => {
    await prepare();
    const screen = track('video');
    display.mockResolvedValue(stream([screen]));
    await media.startScreenShare();
    const held = track('audio');
    vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValue(stream([held]));
    await media.replaceInput('microphone', 'mic-2');
    media.stop();
    expect(held.readyState).toBe('ended');
    expect(screen.readyState).toBe('ended');
    expect(camera.readyState).toBe('ended');
    expect(microphone.readyState).toBe('ended');
    expect(media.screenTrack()).toBeNull();
    expect(media.microphoneTrack()).toBeNull();
    expect(media.cameraTrack()).toBeNull();
  });
});

describe('LocalMedia device loss', () => {
  it('owns ended on the stored camera and microphone and clears it before stopping them', async () => {
    const ended = vi.fn();
    media.setEndedListener(ended);
    await prepare();
    expect(typeof microphone.onended).toBe('function');
    expect(typeof camera.onended).toBe('function');
    microphone.onended?.call(microphone, new Event('ended'));
    camera.onended?.call(camera, new Event('ended'));
    expect(ended.mock.calls).toEqual([['microphone'], ['camera']]);

    const next = track('audio');
    vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValue(stream([next]));
    const held = await media.replaceInput('microphone', 'mic-2');
    expect(held).toBe(next);
    expect(next.onended).toBeNull();
    media.commitInput('microphone', next);
    expect(microphone.onended).toBeNull();
    expect(ended).toHaveBeenCalledTimes(2);
    expect(typeof next.onended).toBe('function');
    next.onended?.call(next, new Event('ended'));
    expect(ended).toHaveBeenLastCalledWith('microphone');

    const superseded = track('audio');
    const supersededEnded = vi.fn();
    superseded.onended = supersededEnded;
    vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValueOnce(stream([superseded]));
    const firstHold = await media.replaceInput('microphone', 'mic-3');
    expect(firstHold).toBe(superseded);
    const newest = track('audio');
    vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValueOnce(stream([newest]));
    await media.replaceInput('microphone', 'mic-4');
    expect(superseded.onended).toBeNull();
    expect(superseded.readyState).toBe('ended');
    expect(supersededEnded).not.toHaveBeenCalled();
    expect(ended).toHaveBeenCalledTimes(3);

    media.stop();
    expect(next.onended).toBeNull();
    expect(camera.onended).toBeNull();
    expect(newest.onended).toBeNull();
  });

  it('keeps the screen-share ended handler when a camera replacement commits', async () => {
    const ended = vi.fn();
    media.setEndedListener(ended);
    await prepare();
    const screen = track('video');
    const screenEnded = vi.fn();
    display.mockResolvedValue(stream([screen]));
    await media.startScreenShare();
    screen.onended = screenEnded;
    const next = track('video');
    vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValue(stream([next]));
    const held = await media.replaceInput('camera', 'cam-2');
    expect(held).toBe(next);
    media.commitInput('camera', next);
    expect(camera.onended).toBeNull();
    expect(screen.onended).toBe(screenEnded);
    expect(screenEnded).not.toHaveBeenCalled();
    expect(ended).not.toHaveBeenCalled();
    expect(screen.readyState).toBe('live');
    media.stop();
    expect(screen.onended).toBeNull();
    expect(next.onended).toBeNull();
  });
});
