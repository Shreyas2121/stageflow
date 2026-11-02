import { describe, expect, it } from 'vitest';
import { acceptChunk, buildHlsArgs, type ChunkHistory, type ChunkMetadata } from './index';

const emptyHistory = (): ChunkHistory => ({ nextExpected: 0, acceptedHashes: new Map() });
const first: ChunkMetadata = { sequence: 0, sha256: 'a'.repeat(64), byteLength: 1024 };

describe('acceptChunk', () => {
  it('accepts sequence zero and advances without mutating the supplied history', () => {
    const history = emptyHistory();
    const decision = acceptChunk(history, first);
    expect(decision).toEqual({
      kind: 'accept',
      nextExpected: 1,
      acceptedHashes: new Map([[0, first.sha256]]),
    });
    expect(history).toEqual(emptyHistory());
  });

  it('recognizes a duplicate and rejects a conflicting hash without changing history', () => {
    const history = acceptChunk(emptyHistory(), first);
    if (history.kind !== 'accept') throw new Error('Expected the first chunk to be accepted');
    expect(acceptChunk(history, first)).toEqual({ kind: 'duplicate' });
    expect(acceptChunk(history, { ...first, sha256: 'b'.repeat(64) })).toEqual({
      kind: 'conflict',
    });
    expect(history.nextExpected).toBe(1);
    expect([...history.acceptedHashes]).toEqual([[0, first.sha256]]);
  });

  it('refuses a future sequence, then accepts it after the missing sequence arrives', () => {
    const history = emptyHistory();
    const second = { ...first, sequence: 1, sha256: 'b'.repeat(64) };
    expect(acceptChunk(history, second)).toEqual({ kind: 'future' });
    const accepted = acceptChunk(history, first);
    if (accepted.kind !== 'accept') throw new Error('Expected the first chunk to be accepted');
    expect(acceptChunk(accepted, second)).toEqual({
      kind: 'accept',
      nextExpected: 2,
      acceptedHashes: new Map([
        [0, first.sha256],
        [1, second.sha256],
      ]),
    });
    expect(accepted.acceptedHashes.has(1)).toBe(false);
  });

  it('keeps earlier hashes so a delayed retry is still a duplicate', () => {
    const history: ChunkHistory = {
      nextExpected: 2,
      acceptedHashes: new Map([
        [0, first.sha256],
        [1, 'b'.repeat(64)],
      ]),
    };
    expect(acceptChunk(history, first)).toEqual({ kind: 'duplicate' });
  });

  it('accepts the exact byte limit and refuses anything larger, including a retry', () => {
    const history = emptyHistory();
    expect(acceptChunk(history, { ...first, byteLength: 2_000_000 }).kind).toBe('accept');
    expect(acceptChunk(history, { ...first, byteLength: 2_000_001 })).toEqual({ kind: 'oversize' });
    const accepted = acceptChunk(history, first);
    if (accepted.kind !== 'accept') throw new Error('Expected the first chunk to be accepted');
    expect(acceptChunk(accepted, { ...first, byteLength: 2_000_001 })).toEqual({
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
