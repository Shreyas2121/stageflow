import { describe, expect, it } from 'vitest';
import {
  acceptChunk,
  broadcastPlaylistUrl,
  broadcastThumbnailUrl,
  buildHlsArgs,
  parseBroadcast,
  resolveBroadcastMediaUrl,
  type BroadcastResponse,
  type ChunkHistory,
  type ChunkMetadata,
} from './index';

const emptyHistory = (): ChunkHistory => ({ nextExpected: 0, acceptedHashes: new Map() });
const first: ChunkMetadata = { sequence: 0, sha256: 'a'.repeat(64), byteLength: 1024 };

describe('acceptChunk', () => {
  it('decides without mutating or iterating the supplied ledger', () => {
    const hashes = new Map<number, string>();
    const history = { nextExpected: 0, acceptedHashes: hashes };
    expect(acceptChunk(history, first)).toEqual({ kind: 'accept' });
    expect(history).toEqual(emptyHistory());
    // Decisions may look up a prior sequence, but must never enumerate or copy history.
    hashes[Symbol.iterator] = () => {
      throw new Error('History enumerated');
    };
    hashes.entries = () => {
      throw new Error('History enumerated');
    };
    for (let sequence = 0; sequence < 50_000; sequence += 1) {
      const chunk = { ...first, sequence };
      expect(acceptChunk(history, { ...chunk, sequence: sequence + 1 })).toEqual({
        kind: 'future',
      });
      expect(acceptChunk(history, chunk)).toEqual({ kind: 'accept' });
      hashes.set(sequence, chunk.sha256);
      history.nextExpected += 1;
      expect(acceptChunk(history, chunk)).toEqual({ kind: 'duplicate' });
      expect(acceptChunk(history, { ...chunk, sha256: 'changed' })).toEqual({ kind: 'conflict' });
    }
    expect(hashes.size).toBe(50_000);
    expect(acceptChunk(history, first)).toEqual({ kind: 'duplicate' });
  });

  it('accepts the exact byte limit and refuses anything larger, including a retry', () => {
    const history = emptyHistory();
    expect(acceptChunk(history, { ...first, byteLength: 2_000_000 }).kind).toBe('accept');
    expect(acceptChunk(history, { ...first, byteLength: 2_000_001 })).toEqual({ kind: 'oversize' });
    const committed = { nextExpected: 1, acceptedHashes: new Map([[0, first.sha256]]) };
    expect(acceptChunk(committed, { ...first, byteLength: 2_000_001 })).toEqual({
      kind: 'oversize',
    });
    expect(history).toEqual(emptyHistory());
  });
});
describe('buildHlsArgs', () => {
  it('locks the WebM input, single video/audio rendition, and complete event playlist', () => {
    const args = buildHlsArgs('/data/broadcasts/server-id');
    const pairs = [
      ['-fflags', '+genpts'],
      ['-f', 'webm'],
      ['-i', 'pipe:0'],
      ['-c:v', 'libx264'],
      ['-pix_fmt', 'yuv420p'],
      ['-s', '1280x720'],
      ['-r', '24'],
      ['-b:v', '2500k'],
      ['-g', '96'],
      ['-sc_threshold', '0'],
      ['-c:a', 'aac'],
      ['-b:a', '128k'],
      ['-ar', '48000'],
      ['-ac', '2'],
      ['-f', 'hls'],
      ['-hls_time', '4'],
      ['-hls_playlist_type', 'event'],
      ['-hls_flags', 'independent_segments'],
      ['-hls_segment_filename', '/data/broadcasts/server-id/segment%06d.ts'],
    ];
    for (const [flag, value] of pairs) {
      expect(args.some((arg, index) => arg === flag && args[index + 1] === value)).toBe(true);
    }
    expect(args.at(-1)).toBe('/data/broadcasts/server-id/index.m3u8');
    expect(args.join(' ')).not.toContain('delete_segments');
    expect(args.filter((arg) => arg === '-c:v')).toHaveLength(1);
    expect(args.filter((arg) => arg === '-i')).toHaveLength(1);
  });

  it('changes only the two output paths when the directory changes', () => {
    const before = buildHlsArgs('/data/broadcasts/one');
    const after = buildHlsArgs('C:\\broadcast data\\two');
    const changes = before.flatMap((arg, index) => (arg === after[index] ? [] : [index]));
    expect(after).toHaveLength(before.length);
    expect(changes).toEqual([before.length - 2, before.length - 1]);
    expect(after.at(-2)).toBe('C:\\broadcast data\\two/segment%06d.ts');
    expect(after.at(-1)).toBe('C:\\broadcast data\\two/index.m3u8');
  });

  it('handles a trailing directory separator without adding a duplicate', () => {
    expect(buildHlsArgs('/data/broadcasts/one/')).toEqual(buildHlsArgs('/data/broadcasts/one'));
    expect(buildHlsArgs('C:\\data\\')).toEqual(buildHlsArgs('C:\\data'));
  });
});

const id = '11111111-1111-4111-8111-111111111111';
const roomId = '22222222-2222-4222-8222-222222222222';
const playlistUrl = `/api/broadcasts/${id}/hls/index.m3u8`;
const thumbnailUrl = `/api/broadcasts/${id}/thumbnail.jpg`;
const apiBase = 'http://127.0.0.1:3000/api';

function response(overrides: Partial<BroadcastResponse> = {}): BroadcastResponse {
  return {
    id,
    roomId,
    status: 'READY',
    playlistUrl,
    thumbnailUrl: null,
    errorMessage: null,
    startedAt: '2026-11-02T00:00:00.000Z',
    endedAt: '2026-11-02T00:01:00.000Z',
    createdAt: '2026-11-02T00:00:00.000Z',
    ...overrides,
  };
}

describe('public broadcast response', () => {
  it('round-trips the catalog object and ignores stored filesystem paths', () => {
    const body = response();
    expect(broadcastPlaylistUrl(id)).toBe(playlistUrl);
    expect(broadcastThumbnailUrl(id)).toBe(thumbnailUrl);
    expect(parseBroadcast(body)).toEqual(body);
    expect(parseBroadcast(response({ thumbnailUrl }))).toEqual(response({ thumbnailUrl }));
    expect(
      parseBroadcast({
        ...body,
        playlistPath: `broadcasts/${id}/index.m3u8`,
        thumbnailPath: `broadcasts/${id}/thumbnail.jpg`,
        extra: true,
      }),
    ).toEqual(body);
    expect(parseBroadcast(response({ status: 'LIVE', playlistUrl: null, endedAt: null }))).toEqual(
      response({ status: 'LIVE', playlistUrl: null, endedAt: null }),
    );
    expect(parseBroadcast(response({ errorMessage: 'x'.repeat(2000) }))?.errorMessage).toHaveLength(
      2000,
    );
  });

  it('rejects malformed ids, statuses, dates, messages, and playlist URLs', () => {
    const rejected = [
      null,
      [],
      'READY',
      response({ id: 'broadcast-1' }),
      response({ roomId: 'room' }),
      { ...response(), status: 'DONE' },
      { ...response(), status: 'live' },
      response({ playlistUrl: 'https://cdn.example/live.m3u8' }),
      response({ playlistUrl: `//cdn.example/api/broadcasts/${id}/hls/index.m3u8` }),
      response({ playlistUrl: `${playlistUrl}?token=1` }),
      response({ playlistUrl: `${playlistUrl}#fragment` }),
      response({ playlistUrl: `/api/broadcasts/${id}/hls/segment000001.ts` }),
      response({ playlistUrl: `broadcasts/${id}/index.m3u8` }),
      response({ playlistUrl: `/api/broadcasts/${id}/hls/../index.m3u8` }),
      response({ playlistUrl: `/api/broadcasts/${id}\\hls\\index.m3u8` }),
      response({ thumbnailUrl: playlistUrl }),
      response({ thumbnailUrl: `https://cdn.example/api/broadcasts/${id}/thumbnail.jpg` }),
      response({ thumbnailUrl: `//cdn.example/api/broadcasts/${id}/thumbnail.jpg` }),
      response({ thumbnailUrl: `${thumbnailUrl}?token=1` }),
      response({ thumbnailUrl: `${thumbnailUrl}#fragment` }),
      response({ thumbnailUrl: `/api/broadcasts/${roomId}/thumbnail.jpg` }),
      response({ thumbnailUrl: `broadcasts/${id}/thumbnail.jpg` }),
      response({ thumbnailUrl: `/api/broadcasts/${id}/thumbnail.jpg/extra` }),
      response({ thumbnailUrl: `/api/broadcasts/${id}\\thumbnail.jpg` }),
      response({ startedAt: '2026-02-31T00:00:00.000Z' }),
      response({ startedAt: '2026-11-02T00:00:00Z' }),
      response({ endedAt: 'yesterday' }),
      response({ createdAt: '2026-11-02' }),
      response({ errorMessage: 'x'.repeat(2001) }),
      { ...response(), playlistUrl: undefined },
      { ...response(), thumbnailUrl: undefined },
      { ...response(), endedAt: undefined },
    ];
    for (const value of rejected) expect(parseBroadcast(value)).toBeNull();
    expect(broadcastPlaylistUrl('not-a-uuid')).toBeNull();
    expect(broadcastThumbnailUrl('not-a-uuid')).toBeNull();
  });

  it('allows the guest token only for the same-origin playlist and its segments', () => {
    const segment = `/api/broadcasts/${id}/hls/segment000001.ts`;
    expect(resolveBroadcastMediaUrl(playlistUrl, apiBase)).toBe(
      `http://127.0.0.1:3000${playlistUrl}`,
    );
    expect(resolveBroadcastMediaUrl(segment, apiBase)).toBe(`http://127.0.0.1:3000${segment}`);
    expect(resolveBroadcastMediaUrl(`http://127.0.0.1:3000${segment}`, apiBase)).toBe(
      `http://127.0.0.1:3000${segment}`,
    );
    const rejected = [
      'https://cdn.example/live.m3u8',
      `//cdn.example${playlistUrl}`,
      `http://127.0.0.1:4000${playlistUrl}`,
      `http://127.0.0.1:3000${playlistUrl}?x=1`,
      `/api/broadcasts/${id}/hls/segment00001.ts`,
      `/api/broadcasts/${id}/hls/index.m3u8/../../rooms`,
      `broadcasts/${id}/index.m3u8`,
      `http://user:pass@127.0.0.1:3000${playlistUrl}`,
    ];
    for (const resource of rejected) expect(resolveBroadcastMediaUrl(resource, apiBase)).toBeNull();
  });
});
