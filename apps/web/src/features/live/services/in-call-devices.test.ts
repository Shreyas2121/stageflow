import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  InCallDeviceController,
  type InCallDeviceHost,
  type InCallDeviceMedia,
} from './in-call-devices';
import type { InputKind } from './local-media';
import type { OutputRouteResult } from './output-route';

const output = vi.hoisted(() => new Set<(result: OutputRouteResult) => void>());
vi.mock('./output-route', () => ({
  selectedOutputId: () => '',
  audioOutputSupported: () => true,
  subscribeAudioOutput: (listener: (result: OutputRouteResult) => void) => {
    output.add(listener);
    return () => {
      output.delete(listener);
    };
  },
}));

function track(kind: 'audio' | 'video'): MediaStreamTrack {
  return { kind, enabled: true, readyState: 'live', stop: vi.fn() } as unknown as MediaStreamTrack;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function settle() {
  for (let index = 0; index < 20; index++) await Promise.resolve();
}

function device(kind: MediaDeviceKind, deviceId: string): MediaDeviceInfo {
  return { kind, deviceId, label: '', groupId: '' } as MediaDeviceInfo;
}

const controllers: InCallDeviceController[] = [];

function harness() {
  const current = { microphone: track('audio'), camera: track('video') };
  const muted = { camera: false, microphone: false };
  const allowed = { active: true, replace: true };
  let ended: ((kind: InputKind) => void) | null = null;
  const media = {
    microphoneTrack: () => current.microphone,
    cameraTrack: () => current.camera,
    screenTrack: vi.fn<InCallDeviceMedia['screenTrack']>(() => null),
    replaceInput: vi.fn<InCallDeviceMedia['replaceInput']>(async (kind) =>
      track(kind === 'camera' ? 'video' : 'audio'),
    ),
    commitInput: vi.fn<InCallDeviceMedia['commitInput']>((kind, next) => {
      current[kind].stop();
      current[kind] = next;
    }),
    abortInput: vi.fn<InCallDeviceMedia['abortInput']>((next) => next.stop()),
    setEndedListener: (listener: typeof ended) => {
      ended = listener;
    },
    setSpeaker: vi.fn<InCallDeviceMedia['setSpeaker']>(async (deviceId) => ({
      ok: true,
      supported: true,
      deviceId,
      message: '',
    })),
  };
  const host = {
    active: () => allowed.active,
    canReplace: () => allowed.replace,
    muted: (kind: InputKind) => muted[kind],
    applyFlags: vi.fn(),
    replaceSender: vi.fn<InCallDeviceHost['replaceSender']>(async () => {}),
    committed: vi.fn(),
    disableInput: vi.fn((kind: InputKind) => {
      muted[kind] = true;
    }),
    inputLost: vi.fn((kind: InputKind) => {
      muted[kind] = true;
    }),
    setError: vi.fn(),
  } satisfies InCallDeviceHost;
  const enumerate = vi.fn(async (): Promise<MediaDeviceInfo[]> => []);
  const controller = new InCallDeviceController(media, host, enumerate);
  controllers.push(controller);
  controller.attach();
  return {
    controller,
    media,
    host,
    enumerate,
    current,
    muted,
    allowed,
    lose: (kind: InputKind) => ended?.(kind),
  };
}

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.dispose();
  output.clear();
  vi.unstubAllGlobals();
});

describe('InCallDeviceController', () => {
  it('caches snapshots and notifies subscribers only when observable state changes', () => {
    const h = harness();
    const initial = h.controller.getSnapshot();
    const changed = vi.fn();
    const unsubscribe = h.controller.subscribe(changed);
    expect(h.controller.getSnapshot()).toBe(initial);
    h.controller.beginPreparation(initial.choices);
    expect(h.controller.getSnapshot()).toBe(initial);
    expect(changed).not.toHaveBeenCalled();
    h.controller.beginPreparation({ cameraId: 'camera-2', microphoneId: '' });
    const selected = h.controller.getSnapshot();
    expect(selected).not.toBe(initial);
    expect(initial.choices.cameraId).toBe('');
    expect(h.controller.getSnapshot()).toBe(selected);
    expect(changed).toHaveBeenCalledOnce();
    unsubscribe();
    h.lose('camera');
    expect(changed).toHaveBeenCalledOnce();
  });

  it('serializes inputs, keeps kind-specific pending state, and commits choices after sender success', async () => {
    const h = harness();
    const capture = deferred<MediaStreamTrack>();
    h.media.replaceInput.mockReturnValueOnce(capture.promise);
    const microphone = h.controller.replace('microphone', 'mic-2');
    const camera = h.controller.replace('camera', 'cam-2');
    expect(h.controller.getSnapshot()).toMatchObject({
      replacingCamera: true,
      replacingMicrophone: true,
    });
    await settle();
    expect(h.media.replaceInput).toHaveBeenCalledExactlyOnceWith('microphone', 'mic-2');
    expect(h.controller.getSnapshot().choices.microphoneId).toBe('');
    const next = track('audio');
    capture.resolve(next);
    await Promise.all([microphone, camera]);
    expect(h.current.microphone).toBe(next);
    expect(h.media.replaceInput.mock.calls).toEqual([
      ['microphone', 'mic-2'],
      ['camera', 'cam-2'],
    ]);
    expect(h.controller.getSnapshot()).toMatchObject({
      replacingCamera: false,
      replacingMicrophone: false,
      choices: { microphoneId: 'mic-2', cameraId: 'cam-2' },
    });
    expect(h.host.committed).toHaveBeenCalledTimes(2);
  });

  it('does not capture when the room disallows replacement', async () => {
    const h = harness();
    h.allowed.replace = false;
    await h.controller.replace('camera', 'cam-2');
    expect(h.media.replaceInput).not.toHaveBeenCalled();
    expect(h.host.replaceSender).not.toHaveBeenCalled();
  });

  it('stores a camera during screen sharing without replacing the screen sender', async () => {
    const h = harness();
    const screen = track('video');
    h.media.screenTrack.mockReturnValue(screen);
    await h.controller.replace('camera', 'cam-2');
    expect(h.controller.getSnapshot().choices.cameraId).toBe('cam-2');
    expect(h.media.commitInput).toHaveBeenCalledOnce();
    expect(h.host.replaceSender).not.toHaveBeenCalled();
    expect(screen.stop).not.toHaveBeenCalled();
  });

  it('uses the current host lock after capture resolves', async () => {
    const h = harness();
    const capture = deferred<MediaStreamTrack>();
    h.media.replaceInput.mockReturnValueOnce(capture.promise);
    const replacing = h.controller.replace('microphone', 'mic-2');
    await settle();
    h.muted.microphone = true;
    const next = track('audio');
    capture.resolve(next);
    await replacing;
    expect(next.enabled).toBe(false);
    expect(h.host.replaceSender).toHaveBeenCalledWith('microphone', next);
  });

  it('keeps the old input and choice on capture failure', async () => {
    const h = harness();
    const previous = h.current.camera;
    h.media.replaceInput.mockRejectedValueOnce(new Error('permission denied'));
    await h.controller.replace('camera', 'cam-2');
    expect(h.current.camera).toBe(previous);
    expect(h.controller.getSnapshot().choices.cameraId).toBe('');
    expect(h.host.setError).toHaveBeenCalledExactlyOnceWith('permission denied');
    expect(h.host.replaceSender).not.toHaveBeenCalled();
  });

  it('restores the previous sender after a rejected replacement and stops only the held input', async () => {
    const h = harness();
    const previous = h.current.microphone;
    const next = track('audio');
    h.media.replaceInput.mockResolvedValueOnce(next);
    h.host.replaceSender.mockRejectedValueOnce(new Error('sender rejected'));
    await h.controller.replace('microphone', 'mic-2');
    expect(h.host.replaceSender.mock.calls).toEqual([
      ['microphone', next],
      ['microphone', previous],
    ]);
    expect(h.current.microphone).toBe(previous);
    expect(next.stop).toHaveBeenCalledOnce();
    expect(previous.stop).not.toHaveBeenCalled();
    expect(h.host.disableInput).not.toHaveBeenCalled();
    expect(h.host.setError).toHaveBeenCalledExactlyOnceWith('sender rejected');
  });

  it('disables the affected input when sender rollback fails', async () => {
    const h = harness();
    h.host.replaceSender
      .mockRejectedValueOnce(new Error('replace'))
      .mockRejectedValueOnce(new Error('rollback'));
    await h.controller.replace('microphone', 'mic-2');
    expect(h.host.disableInput).toHaveBeenCalledExactlyOnceWith('microphone');
    expect(h.host.setError).toHaveBeenCalledExactlyOnceWith(
      'Unable to switch your microphone. The microphone is off until you choose another.',
    );
    expect(h.media.commitInput).not.toHaveBeenCalled();
  });

  it('cancels active and queued requests from an old generation while accepting new explicit work', async () => {
    const h = harness();
    const capture = deferred<MediaStreamTrack>();
    h.media.replaceInput.mockReturnValueOnce(capture.promise);
    const first = h.controller.replace('microphone', 'obsolete-mic');
    const queued = h.controller.replace('camera', 'obsolete-cam');
    await settle();
    h.controller.reset();
    const fresh = h.controller.replace('camera', 'fresh-cam');
    const obsolete = track('audio');
    capture.resolve(obsolete);
    await Promise.all([first, queued, fresh]);
    expect(obsolete.stop).toHaveBeenCalledOnce();
    expect(h.media.replaceInput.mock.calls).toEqual([
      ['microphone', 'obsolete-mic'],
      ['camera', 'fresh-cam'],
    ]);
    expect(h.controller.getSnapshot().choices).toEqual({ microphoneId: '', cameraId: 'fresh-cam' });
    expect(h.controller.getSnapshot().replacingCamera).toBe(false);
    expect(h.host.setError).not.toHaveBeenCalled();
  });

  it('discards a held track when the room cancels during sender replacement', async () => {
    const h = harness();
    const sender = deferred<void>();
    const next = track('video');
    h.media.replaceInput.mockResolvedValueOnce(next);
    h.host.replaceSender.mockReturnValueOnce(sender.promise);
    const replacing = h.controller.replace('camera', 'cam-2');
    await settle();
    h.controller.reset();
    sender.resolve();
    await replacing;
    expect(next.stop).toHaveBeenCalledOnce();
    expect(h.media.commitInput).not.toHaveBeenCalled();
    expect(h.controller.getSnapshot().choices.cameraId).toBe('');
  });

  it('does not disable or report an old rollback failure in a newer generation', async () => {
    const h = harness();
    const rollback = deferred<void>();
    h.host.replaceSender
      .mockRejectedValueOnce(new Error('replace'))
      .mockReturnValueOnce(rollback.promise);
    const replacing = h.controller.replace('microphone', 'mic-2');
    await settle();
    expect(h.host.replaceSender).toHaveBeenCalledTimes(2);
    h.controller.reset();
    rollback.reject(new Error('obsolete rollback'));
    await replacing;
    expect(h.media.abortInput).toHaveBeenCalledOnce();
    expect(h.host.disableInput).not.toHaveBeenCalled();
    expect(h.host.setError).not.toHaveBeenCalled();
  });

  it('uses the current peer sender when membership changes during capture', async () => {
    const h = harness();
    const capture = deferred<MediaStreamTrack>();
    h.media.replaceInput.mockReturnValueOnce(capture.promise);
    const oldPeer = vi.fn<InCallDeviceHost['replaceSender']>(async () => {});
    const newPeer = vi.fn<InCallDeviceHost['replaceSender']>(async () => {});
    let peer = oldPeer;
    h.host.replaceSender.mockImplementation((kind, next) => peer(kind, next));
    const replacing = h.controller.replace('camera', 'cam-2');
    await settle();
    peer = newPeer;
    const next = track('video');
    capture.resolve(next);
    await replacing;
    expect(oldPeer).not.toHaveBeenCalled();
    expect(newPeer).toHaveBeenCalledExactlyOnceWith('camera', next);
    expect(h.current.camera).toBe(next);
  });

  it('looks up the current sender capability again when rollback starts', async () => {
    const h = harness();
    const pending = deferred<void>();
    const oldPeer = vi.fn<InCallDeviceHost['replaceSender']>(() => pending.promise);
    const newPeer = vi.fn<InCallDeviceHost['replaceSender']>(async () => {});
    let peer = oldPeer;
    h.host.replaceSender.mockImplementation((kind, next) => peer(kind, next));
    const replacing = h.controller.replace('camera', 'cam-2');
    await settle();
    peer = newPeer;
    pending.reject(new Error('peer changed'));
    await replacing;
    expect(oldPeer).toHaveBeenCalledOnce();
    expect(newPeer).toHaveBeenCalledExactlyOnceWith('camera', h.current.camera);
  });

  it('reports source loss once and clears unavailability on an explicit replacement', async () => {
    const h = harness();
    h.lose('microphone');
    h.lose('microphone');
    expect(h.controller.getSnapshot().microphoneUnavailable).toBe(true);
    expect(h.host.inputLost).toHaveBeenCalledExactlyOnceWith('microphone');
    expect(h.media.replaceInput).not.toHaveBeenCalled();
    await h.controller.replace('microphone', 'mic-2');
    expect(h.controller.getSnapshot().microphoneUnavailable).toBe(false);
    expect(h.current.microphone.enabled).toBe(false);
  });

  it('ignores source loss when inactive or detached', () => {
    const h = harness();
    h.allowed.active = false;
    h.lose('camera');
    h.allowed.active = true;
    h.controller.dispose();
    h.lose('microphone');
    expect(h.host.inputLost).not.toHaveBeenCalled();
  });

  it('enumerates attendee output devices without capture or invented labels', async () => {
    const h = harness();
    h.allowed.replace = false;
    const allowed = [device('audiooutput', 'speaker-2')];
    h.enumerate.mockResolvedValueOnce(allowed);
    await h.controller.refresh();
    expect(h.controller.getSnapshot().devices).toBe(allowed);
    expect(h.controller.getSnapshot().devices[0]!.label).toBe('');
    expect(h.media.replaceInput).not.toHaveBeenCalled();
  });

  it('ignores stale enumeration after a newer refresh or a reset', async () => {
    const h = harness();
    const old = deferred<MediaDeviceInfo[]>();
    const latest = [device('audiooutput', 'latest')];
    h.enumerate.mockReturnValueOnce(old.promise).mockResolvedValueOnce(latest);
    const first = h.controller.refresh();
    await h.controller.refresh();
    const snapshot = h.controller.getSnapshot();
    old.resolve([device('audiooutput', 'old')]);
    await first;
    expect(h.controller.getSnapshot()).toBe(snapshot);
    const pending = deferred<MediaDeviceInfo[]>();
    h.enumerate.mockReturnValueOnce(pending.promise);
    const next = h.controller.refresh();
    h.controller.reset();
    pending.resolve([]);
    await next;
    expect(h.controller.getSnapshot().devices).toBe(latest);
  });

  it('lets devicechange inventory win over an older preparation read', async () => {
    const h = harness();
    const old = deferred<MediaDeviceInfo[]>();
    const latest = [device('audiooutput', 'latest')];
    h.enumerate.mockReturnValueOnce(old.promise).mockResolvedValueOnce(latest);
    const preparing = h.controller.enumerateForPreparation();
    await h.controller.refresh();
    old.resolve([]);
    await preparing;
    expect(h.controller.getSnapshot().devices).toBe(latest);
  });

  it('retains inventory on refresh failure and propagates preparation failure to its owner', async () => {
    const h = harness();
    const allowed = [device('audiooutput', 'speaker')];
    h.enumerate.mockResolvedValueOnce(allowed);
    await h.controller.refresh();
    h.enumerate.mockRejectedValueOnce(new Error('enumeration'));
    await h.controller.refresh();
    expect(h.controller.getSnapshot().devices).toBe(allowed);
    h.enumerate.mockRejectedValueOnce(new Error('preparation'));
    await expect(h.controller.enumerateForPreparation()).rejects.toThrow('preparation');
  });

  it('marks missing selected inputs but leaves the browser default available', async () => {
    const h = harness();
    h.controller.beginPreparation({ cameraId: 'removed-camera', microphoneId: '' });
    await h.controller.refresh();
    expect(h.controller.getSnapshot()).toMatchObject({
      cameraUnavailable: true,
      microphoneUnavailable: false,
    });
    expect(h.host.inputLost).toHaveBeenCalledExactlyOnceWith('camera');
    expect(h.media.replaceInput).not.toHaveBeenCalled();
  });

  it('attaches and removes device/output listeners idempotently, including reattachment', async () => {
    const events = new EventTarget();
    const add = vi.spyOn(events, 'addEventListener');
    const remove = vi.spyOn(events, 'removeEventListener');
    vi.stubGlobal('navigator', { mediaDevices: events });
    const h = harness();
    h.controller.attach();
    expect(add).toHaveBeenCalledOnce();
    expect(output.size).toBe(1);
    events.dispatchEvent(new Event('devicechange'));
    await settle();
    expect(h.enumerate).toHaveBeenCalledOnce();
    h.controller.dispose();
    h.controller.dispose();
    expect(remove).toHaveBeenCalledOnce();
    expect(output.size).toBe(0);
    events.dispatchEvent(new Event('devicechange'));
    await settle();
    expect(h.enumerate).toHaveBeenCalledOnce();
    h.controller.attach();
    events.dispatchEvent(new Event('devicechange'));
    await settle();
    expect(h.enumerate).toHaveBeenCalledTimes(2);
    expect(output.size).toBe(1);
  });

  it('publishes output fallback errors and clears them on successful reselection', async () => {
    const h = harness();
    const failed = {
      ok: false,
      supported: true,
      deviceId: '',
      message: 'saved speaker unavailable',
    };
    for (const listener of output) listener(failed);
    expect(h.controller.getSnapshot()).toMatchObject({
      speakerId: '',
      speakerError: failed.message,
    });
    await h.controller.setSpeaker('speaker-2');
    expect(h.controller.getSnapshot()).toMatchObject({ speakerId: 'speaker-2', speakerError: '' });
    h.allowed.active = false;
    for (const listener of output) listener(failed);
    expect(h.controller.getSnapshot().speakerId).toBe('speaker-2');
  });

  it('ignores output results invalidated by teardown or a superseded preparation', async () => {
    const h = harness();
    const route = deferred<OutputRouteResult>();
    h.media.setSpeaker.mockReturnValueOnce(route.promise);
    const selecting = h.controller.setSpeaker('old-speaker');
    h.controller.reset();
    route.resolve({ ok: true, supported: true, deviceId: 'old-speaker', message: '' });
    await selecting;
    expect(h.controller.getSnapshot().speakerId).toBe('');
    await h.controller.setSpeaker('superseded-speaker', () => false);
    expect(h.controller.getSnapshot().speakerId).toBe('');
  });
});
