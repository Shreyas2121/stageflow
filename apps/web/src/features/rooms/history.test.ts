import { describe, expect, it } from 'vitest';
import { mergeById, replayHref } from './history';

const id = '11111111-1111-4111-8111-111111111111';
const playlistUrl = `/api/broadcasts/${id}/hls/index.m3u8`;

describe('replayHref', () => {
  it('links only a READY row whose playlist is a catalog playlist', () => {
    expect(replayHref({ id, status: 'READY', playlistUrl })).toBe(`/replay/${id}`);
    for (const status of ['STARTING', 'LIVE', 'STOPPING', 'FAILED'] as const) {
      expect(replayHref({ id, status, playlistUrl })).toBeNull();
    }
    expect(replayHref({ id, status: 'READY', playlistUrl: null })).toBeNull();
    expect(
      replayHref({ id, status: 'READY', playlistUrl: 'https://cdn.example/live.m3u8' }),
    ).toBeNull();
    expect(
      replayHref({
        id,
        status: 'READY',
        playlistUrl: `/api/broadcasts/${id}/hls/segment000001.ts`,
      }),
    ).toBeNull();
  });
});

describe('mergeById', () => {
  it('keeps the earlier row when a later page repeats an id', () => {
    expect(
      mergeById([
        [{ id: 'a', n: 1 }],
        [
          { id: 'a', n: 2 },
          { id: 'b', n: 3 },
        ],
      ]),
    ).toEqual([
      { id: 'a', n: 1 },
      { id: 'b', n: 3 },
    ]);
  });
});
