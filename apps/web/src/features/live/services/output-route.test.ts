import { describe, expect, it, vi } from 'vitest';
import { routeAudioOutput } from './output-route';

function element(setSinkId?: (id: string) => Promise<void>, sinkId = '') {
  return { setSinkId, sinkId } as HTMLMediaElement & {
    setSinkId?: (id: string) => Promise<void>;
    sinkId?: string;
  };
}

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
});
