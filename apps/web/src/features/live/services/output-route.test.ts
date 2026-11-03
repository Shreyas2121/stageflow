import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  audioOutputSupported,
  bindAudioOutput,
  routeAudioOutput,
  selectAudioOutput,
  selectedOutputId,
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
