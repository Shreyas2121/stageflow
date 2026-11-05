import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  audioOutputSupported,
  bindAudioOutput,
  routeAudioOutput,
  selectAudioOutput,
  selectedOutputId,
  subscribeAudioOutput,
  type OutputRouteResult,
} from './output-route';

function element(setSinkId?: (id: string) => Promise<void>, sinkId = '') {
  return { setSinkId, sinkId } as HTMLMediaElement & {
    setSinkId?: (id: string) => Promise<void>;
    sinkId?: string;
  };
}

function accepting(initial = '') {
  const target = element(undefined, initial);
  target.setSinkId = vi.fn(async (id: string) => {
    target.sinkId = id;
  });
  return target;
}

function rejecting(id: string, initial = '') {
  const target = element(undefined, initial);
  target.setSinkId = vi.fn(async (next: string) => {
    if (next === id) throw new Error('device not found');
    target.sinkId = next;
  });
  return target;
}

const releases: Array<() => void> = [];

function bind(
  target: HTMLMediaElement,
  onResult?: (result: OutputRouteResult) => void,
): () => void {
  const release = bindAudioOutput(target, onResult);
  releases.push(release);
  return release;
}

afterEach(async () => {
  for (const release of releases) release();
  releases.length = 0;
  vi.unstubAllGlobals();
  await selectAudioOutput('');
});

describe('audio output routing', () => {
  it('continues on the default output when the browser has no speaker selection', async () => {
    const result = await routeAudioOutput(element(), 'speaker-a');
    expect(result).toEqual({ ok: true, supported: false, deviceId: '', message: '' });
  });

  it('skips a speaker that is already selected', async () => {
    const setSinkId = vi.fn(async () => undefined);
    const result = await routeAudioOutput(element(setSinkId, 'speaker-a'), 'speaker-a');
    expect(setSinkId).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true, supported: true, deviceId: 'speaker-a', message: '' });
  });

  it('applies a new speaker', async () => {
    const setSinkId = vi.fn(async (id: string) => {
      expect(id).toBe('speaker-a');
    });
    const result = await routeAudioOutput(element(setSinkId, ''), 'speaker-a');
    expect(result).toEqual({ ok: true, supported: true, deviceId: 'speaker-a', message: '' });
  });

  it('falls back to the default output and keeps the speaker error', async () => {
    const setSinkId = vi.fn(async (id: string) => {
      if (id === 'speaker-b') throw new Error('device not found');
    });
    const target = element(setSinkId, 'speaker-a');
    const result = await routeAudioOutput(target, 'speaker-b');
    expect(setSinkId.mock.calls.map((call) => call[0])).toEqual(['speaker-b', '']);
    expect(result).toEqual({
      ok: false,
      supported: true,
      deviceId: '',
      message: 'Unable to use that speaker. device not found',
    });
  });

  it('reports a default-output failure without trying it twice', async () => {
    const setSinkId = vi.fn(async () => {
      throw new Error('default rejected');
    });
    const result = await routeAudioOutput(element(setSinkId, 'speaker-a'), '');
    expect(setSinkId).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
    expect(result.message).toBe('Unable to use that speaker. default rejected');
  });

  it('applies a speaker id saved before the element is bound', async () => {
    await selectAudioOutput('speaker-a');
    const target = accepting();
    const seen: OutputRouteResult[] = [];
    bind(target, (result) => seen.push(result));
    await vi.waitFor(() => expect(target.sinkId).toBe('speaker-a'));
    expect(seen.at(-1)).toEqual({ ok: true, supported: true, deviceId: 'speaker-a', message: '' });
  });

  it('reports an unsupported element without throwing', async () => {
    const seen: OutputRouteResult[] = [];
    bind(element(), (result) => seen.push(result));
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]).toEqual({ ok: true, supported: false, deviceId: '', message: '' });
  });

  it('clears a saved output rejected at bind time and resets existing elements to default', async () => {
    await selectAudioOutput('missing');
    const existing = accepting();
    bind(existing);
    await vi.waitFor(() => expect(existing.sinkId).toBe('missing'));
    const seen: OutputRouteResult[] = [];
    const added = rejecting('missing');
    bind(added, (result) => seen.push(result));
    await vi.waitFor(() => expect(selectedOutputId()).toBe(''));
    expect(existing.sinkId).toBe('');
    expect(added.sinkId).toBe('');
    expect(seen.at(-1)).toMatchObject({
      ok: false,
      deviceId: '',
      message: expect.stringContaining('device not found'),
    });
  });

  it('clears a saved output when the new playback element cannot select a sink', async () => {
    await selectAudioOutput('saved');
    const seen: OutputRouteResult[] = [];
    bind(element(), (result) => seen.push(result));
    await vi.waitFor(() => expect(seen).not.toHaveLength(0));
    expect(selectedOutputId()).toBe('');
    expect(seen.at(-1)).toEqual({ ok: true, supported: false, deviceId: '', message: '' });
  });

  it('publishes one final bind failure to selection controls and releases their listener', async () => {
    await selectAudioOutput('missing');
    const seen = vi.fn((result: OutputRouteResult) => {
      expect(selectedOutputId()).toBe(result.deviceId);
    });
    const unsubscribe = subscribeAudioOutput(seen);
    releases.push(unsubscribe);
    bind(rejecting('missing'));
    await vi.waitFor(() => expect(seen).toHaveBeenCalledOnce());
    expect(seen).toHaveBeenLastCalledWith({
      ok: false,
      supported: true,
      deviceId: '',
      message: 'Unable to use that speaker. device not found',
    });
    unsubscribe();
    await selectAudioOutput('available');
    expect(seen).toHaveBeenCalledOnce();
  });

  it('ignores a late bind failure after its element has been removed', async () => {
    await selectAudioOutput('saved');
    let reject!: (error: Error) => void;
    const setSinkId = vi.fn(
      () =>
        new Promise<void>((_resolve, fail) => {
          reject = fail;
        }),
    );
    const seen = vi.fn();
    const release = bind(element(setSinkId), seen);
    await vi.waitFor(() => expect(setSinkId).toHaveBeenCalledOnce());
    release();
    reject(new Error('device not found'));
    await selectAudioOutput('newer');
    expect(seen).not.toHaveBeenCalled();
    expect(selectedOutputId()).toBe('newer');
  });

  it('resets to default if neither the new selection nor the saved output can be restored', async () => {
    await selectAudioOutput('previous');
    const target = accepting();
    bind(target);
    await vi.waitFor(() => expect(target.sinkId).toBe('previous'));
    target.setSinkId = vi.fn(async (id: string) => {
      if (id) throw new Error('device not found');
      target.sinkId = '';
    });
    const result = await selectAudioOutput('next');
    expect(result).toMatchObject({ ok: false, deviceId: '' });
    expect(selectedOutputId()).toBe('');
    expect(target.sinkId).toBe('');
  });

  it('keeps the previous id when a bound element rejects the next one', async () => {
    await selectAudioOutput('speaker-a');
    const target = rejecting('speaker-b');
    bind(target);
    await vi.waitFor(() => expect(target.sinkId).toBe('speaker-a'));
    const result = await selectAudioOutput('speaker-b');
    expect(result).toEqual({
      ok: false,
      supported: true,
      deviceId: 'speaker-a',
      message: 'Unable to use that speaker. device not found',
    });
    expect(selectedOutputId()).toBe('speaker-a');
    expect(target.sinkId).toBe('speaker-a');
  });

  it('restores every bound element when one rejects the new id', async () => {
    await selectAudioOutput('keep');
    const good = accepting();
    const bad = rejecting('next');
    bind(good);
    bind(bad);
    await vi.waitFor(() => {
      expect(good.sinkId).toBe('keep');
      expect(bad.sinkId).toBe('keep');
    });
    const result = await selectAudioOutput('next');
    expect(result.ok).toBe(false);
    expect(result.deviceId).toBe('keep');
    expect(selectedOutputId()).toBe('keep');
    expect(good.sinkId).toBe('keep');
    expect(bad.sinkId).toBe('keep');
  });

  it('saves an id when nothing is bound and does not clear it as unsupported', async () => {
    const result = await selectAudioOutput('speaker-a');
    expect(result).toEqual({
      ok: true,
      supported: audioOutputSupported(),
      deviceId: 'speaker-a',
      message: '',
    });
    expect(selectedOutputId()).toBe('speaker-a');
  });

  it('saves the default speaker even when an element rejects it', async () => {
    await selectAudioOutput('speaker-a');
    const target = rejecting('');
    bind(target);
    await vi.waitFor(() => expect(target.sinkId).toBe('speaker-a'));
    const result = await selectAudioOutput('');
    expect(result.ok).toBe(false);
    expect(result.deviceId).toBe('');
    expect(result.message).toContain('device not found');
    expect(selectedOutputId()).toBe('');
  });

  it('keeps the selected id in memory when storage throws', async () => {
    let stored: string | null = '';
    vi.stubGlobal('sessionStorage', {
      getItem: () => stored,
      setItem: (_key: string, value: string) => {
        if (value === 'speaker-a') throw new Error('blocked');
        stored = value;
      },
    });
    await selectAudioOutput('speaker-a');
    expect(selectedOutputId()).toBe('speaker-a');
    expect(stored).toBe('');
    await selectAudioOutput('speaker-b');
    expect(stored).toBe('speaker-b');
    expect(selectedOutputId()).toBe('speaker-b');
  });

  it('does not let an unbound element reject the saved id', async () => {
    const release = bind(rejecting('speaker-b'));
    release();
    const result = await selectAudioOutput('speaker-b');
    expect(result.ok).toBe(true);
    expect(result.deviceId).toBe('speaker-b');
    expect(selectedOutputId()).toBe('speaker-b');
  });

  it('does not let replay or output routing capture a camera or microphone', () => {
    const replay = readFileSync(new URL('../../../pages/ReplayPage.tsx', import.meta.url), 'utf8');
    const route = readFileSync(new URL('./output-route.ts', import.meta.url), 'utf8');
    expect(replay).not.toMatch(/getUserMedia/);
    expect(route).not.toMatch(/getUserMedia/);
  });
});
