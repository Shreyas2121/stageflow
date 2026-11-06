import { describe, expect, it, vi } from 'vitest';
import {
  BroadcastSession,
  PRODUCER_FAILURE,
  RECORDER_START_FAILURE,
  recordingFinishError,
  type BroadcastSessionHost,
  type BroadcastSyncInput,
} from './broadcast-session';
import type { RecorderFinish, StageSource } from './stage-recorder';

const live = { id: 'broadcast-1', status: 'LIVE' as const };

function sourcesOf(...ids: string[]): StageSource[] {
  return ids.map((id) => ({
    id,
    video: null,
    audioTrack: null,
    muted: false,
    screenSharing: false,
  }));
}

function recorderFake() {
  return {
    start: vi.fn(),
    update: vi.fn(),
    setLowerThird: vi.fn(),
    stop: vi.fn(),
    finish: vi.fn(() => Promise.resolve<RecorderFinish>({ ok: true })),
  };
}

function opened(createRecorder: BroadcastSessionHost['createRecorder']) {
  const order: string[] = [];
  const stopBroadcast = vi.fn(() => {
    order.push('stop');
  });
  const onError = vi.fn((message: string) => {
    order.push(`error:${message}`);
  });
  const session = new BroadcastSession({
    token: 'token',
    createRecorder,
    stopBroadcast,
    onError,
  });
  return { session, stopBroadcast, onError, order };
}

function sync(
  session: BroadcastSession,
  input: Partial<BroadcastSyncInput> & Pick<BroadcastSyncInput, 'broadcast'>,
  sources: BroadcastSyncInput['sources'] = () => sourcesOf('self'),
): void {
  session.sync({ joined: true, sources, ...input });
}

describe('BroadcastSession', () => {
  it('stores the feature without starting, supplies it before recorder start, and forwards replacement/clear', () => {
    const recorder = recorderFake();
    const createRecorder = vi.fn(() => recorder);
    const { session, stopBroadcast } = opened(createRecorder);
    const feature = { text: 'Before recording', authorName: 'Sam' };
    session.setLowerThird(feature);
    sync(session, { broadcast: live });
    expect(createRecorder).not.toHaveBeenCalled();
    expect(session.active).toBe(false);
    session.arm();
    sync(session, { broadcast: live });
    expect(recorder.setLowerThird).toHaveBeenCalledExactlyOnceWith(feature);
    expect(recorder.setLowerThird.mock.invocationCallOrder[0]).toBeLessThan(
      recorder.start.mock.invocationCallOrder[0]!,
    );
    session.setLowerThird({ text: 'Replacement', authorName: 'Ava' });
    expect(recorder.setLowerThird).toHaveBeenLastCalledWith({
      text: 'Replacement',
      authorName: 'Ava',
    });
    session.setLowerThird(null);
    expect(recorder.setLowerThird).toHaveBeenLastCalledWith(null);
    expect(recorder.start).toHaveBeenCalledOnce();
    expect(stopBroadcast).not.toHaveBeenCalled();
  });
  it('starts only after arm, while joined, on the live broadcast', () => {
    const recorder = recorderFake();
    const createRecorder = vi.fn(() => recorder);
    const { session } = opened(createRecorder);
    const read = vi.fn(() => sourcesOf('self'));
    expect(session.active).toBe(false);
    sync(session, { broadcast: live }, read);
    session.arm();
    expect(session.active).toBe(true);
    sync(session, { joined: false, broadcast: live }, read);
    sync(session, { broadcast: { id: live.id, status: 'STARTING' } }, read);
    sync(session, { broadcast: { id: live.id, status: 'READY' } }, read);
    sync(session, { broadcast: { id: live.id, status: 'FAILED' } }, read);
    sync(session, { broadcast: null }, read);
    expect(createRecorder).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    sync(session, { broadcast: live }, read);
    expect(createRecorder).toHaveBeenCalledOnce();
    expect(createRecorder).toHaveBeenCalledWith(
      expect.objectContaining({ broadcastId: 'broadcast-1', token: 'token' }),
    );
    expect(recorder.start).toHaveBeenCalledOnce();
    expect(recorder.update).toHaveBeenCalledWith(sourcesOf('self'));
    expect(read).toHaveBeenCalledOnce();
    sync(session, { broadcast: live }, () => sourcesOf('self', 'guest'));
    expect(recorder.start).toHaveBeenCalledOnce();
    expect(recorder.update).toHaveBeenLastCalledWith(sourcesOf('self', 'guest'));
  });

  it('stops the open recorder when that broadcast is no longer live', () => {
    const recorder = recorderFake();
    const { session } = opened(() => recorder);
    session.arm();
    sync(session, { broadcast: live });
    const read = vi.fn(() => sourcesOf('self'));
    sync(session, { joined: false, broadcast: live }, read);
    expect(recorder.stop).toHaveBeenCalledOnce();
    expect(recorder.finish).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(session.active).toBe(false);
    sync(session, { broadcast: live }, read);
    expect(recorder.start).toHaveBeenCalledOnce();

    session.arm();
    sync(session, { broadcast: live });
    sync(session, { broadcast: { id: 'other', status: 'LIVE' } }, read);
    expect(recorder.stop).toHaveBeenCalledTimes(2);
    session.arm();
    sync(session, { broadcast: live });
    sync(session, { broadcast: { id: live.id, status: 'STOPPING' } }, read);
    expect(recorder.stop).toHaveBeenCalledTimes(3);
    expect(recorder.finish).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it('finishes the open recorder once and reports a clean second finish', async () => {
    const recorder = recorderFake();
    const { session } = opened(() => recorder);
    session.arm();
    sync(session, { broadcast: live });
    await expect(session.finish()).resolves.toEqual({ ok: true });
    expect(recorder.finish).toHaveBeenCalledOnce();
    expect(recorder.stop).not.toHaveBeenCalled();
    expect(session.active).toBe(false);
    await expect(session.finish()).resolves.toEqual({ ok: true });
    expect(recorder.finish).toHaveBeenCalledOnce();
  });

  it('keeps a replacement recording when an older finish settles', async () => {
    const first = recorderFake();
    const second = recorderFake();
    let resolveFinish: (result: RecorderFinish) => void = () => undefined;
    first.finish.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFinish = resolve;
        }),
    );
    const recorders = [first, second];
    let created = 0;
    const { session } = opened(() => {
      const recorder = recorders[created];
      created += 1;
      if (!recorder) throw new Error('unexpected recorder');
      return recorder;
    });
    session.arm();
    sync(session, { broadcast: live });
    const pending = session.finish();
    session.abort();
    expect(first.stop).toHaveBeenCalledOnce();
    expect(session.active).toBe(false);
    session.arm();
    sync(session, { broadcast: live }, () => sourcesOf('guest'));
    expect(second.start).toHaveBeenCalledOnce();
    resolveFinish({ ok: false, reason: 'aborted' });
    await expect(pending).resolves.toEqual({ ok: false, reason: 'aborted' });
    expect(second.stop).not.toHaveBeenCalled();
    expect(session.active).toBe(true);
    sync(session, { broadcast: live }, () => sourcesOf('guest'));
    expect(second.update).toHaveBeenLastCalledWith(sourcesOf('guest'));
  });

  it('asks the room to stop before reporting a recorder that never opened', () => {
    const read = vi.fn(() => sourcesOf('self'));
    const { session, stopBroadcast, onError, order } = opened(() => {
      throw new Error('no canvas');
    });
    session.arm();
    sync(session, { broadcast: live }, read);
    expect(read).not.toHaveBeenCalled();
    expect(stopBroadcast).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(RECORDER_START_FAILURE);
    expect(order).toEqual(['stop', `error:${RECORDER_START_FAILURE}`]);
    expect(session.active).toBe(false);
    sync(session, { broadcast: live }, read);
    expect(stopBroadcast).toHaveBeenCalledOnce();
  });

  it('stops a recorder whose start or first update throws', () => {
    const started = recorderFake();
    started.start.mockImplementation(() => {
      throw new Error('mime');
    });
    const updated = recorderFake();
    updated.update.mockImplementation(() => {
      throw new Error('source');
    });
    const recorders = [started, updated];
    let created = 0;
    const { session, order } = opened(() => {
      const recorder = recorders[created];
      created += 1;
      if (!recorder) throw new Error('unexpected recorder');
      return recorder;
    });
    session.arm();
    sync(session, { broadcast: live });
    expect(started.stop).toHaveBeenCalledOnce();
    session.arm();
    sync(session, { broadcast: live });
    expect(updated.start).toHaveBeenCalledOnce();
    expect(updated.stop).toHaveBeenCalledOnce();
    expect(order).toEqual([
      'stop',
      `error:${RECORDER_START_FAILURE}`,
      'stop',
      `error:${RECORDER_START_FAILURE}`,
    ]);
    expect(session.active).toBe(false);
  });

  it('reports a producer cap and ignores a cap from a recorder that was replaced', () => {
    const first = recorderFake();
    const second = recorderFake();
    const caps: Array<() => void> = [];
    const recorders = [first, second];
    let created = 0;
    const { session, stopBroadcast, onError, order } = opened((options) => {
      caps.push(options.onCap);
      const recorder = recorders[created];
      created += 1;
      if (!recorder) throw new Error('unexpected recorder');
      return recorder;
    });
    session.arm();
    sync(session, { broadcast: live });
    caps[0]?.();
    expect(first.stop).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(PRODUCER_FAILURE);
    expect(stopBroadcast).toHaveBeenCalledOnce();
    expect(order).toEqual([`error:${PRODUCER_FAILURE}`, 'stop']);
    expect(session.active).toBe(false);

    session.arm();
    sync(session, { broadcast: live });
    caps[0]?.();
    expect(second.stop).not.toHaveBeenCalled();
    expect(stopBroadcast).toHaveBeenCalledOnce();
    caps[1]?.();
    expect(second.stop).toHaveBeenCalledOnce();
    expect(stopBroadcast).toHaveBeenCalledTimes(2);
    expect(order[2]).toBe(`error:${PRODUCER_FAILURE}`);
    expect(order[3]).toBe('stop');
  });
});

describe('recordingFinishError', () => {
  it('stays quiet when the upload finished or was aborted', () => {
    expect(recordingFinishError({ ok: true })).toBeNull();
    expect(recordingFinishError({ ok: false, reason: 'aborted' })).toBeNull();
  });

  it('names the drain failure', () => {
    expect(recordingFinishError({ ok: false, reason: 'recorder' })).toBe(
      'The broadcast recorder failed before recording finished.',
    );
    expect(recordingFinishError({ ok: false, reason: 'timeout' })).toBe(
      'The broadcast stopped before the last of the recording uploaded.',
    );
    expect(recordingFinishError({ ok: false, reason: 'upload' })).toBe(
      'The broadcast stopped before every recorded chunk was accepted.',
    );
  });
});
