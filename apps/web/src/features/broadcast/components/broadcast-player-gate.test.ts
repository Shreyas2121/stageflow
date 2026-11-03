import { describe, expect, it, vi } from 'vitest';

const hls = vi.hoisted(() => ({ loaded: false }));

vi.mock('hls.js', () => {
  hls.loaded = true;
  return { default: class Hls {} };
});

describe('broadcast player gate', () => {
  it('does not evaluate hls.js until playback requests the player', async () => {
    hls.loaded = false;
    vi.resetModules();
    const gate = await import('./broadcast-player-gate');
    expect(hls.loaded).toBe(false);
    const player = await gate.loadBroadcastPlayer();
    expect(hls.loaded).toBe(true);
    expect(player.default).toBeTypeOf('function');
  });
});
