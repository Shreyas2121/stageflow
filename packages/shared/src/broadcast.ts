export type BroadcastStatus = 'STARTING' | 'LIVE' | 'STOPPING' | 'READY' | 'FAILED';

export type ChunkHistory = {
  nextExpected: number;
  acceptedHashes: ReadonlyMap<number, string>;
};

export type ChunkMetadata = {
  sequence: number;
  sha256: string;
  byteLength: number;
};

export type ChunkDecision =
  ({ kind: 'accept' } & ChunkHistory) | { kind: 'duplicate' | 'conflict' | 'future' | 'oversize' };

/** Metadata is validated and SHA-256 is computed by the caller; no bytes are read here. */
export function acceptChunk(history: ChunkHistory, chunk: ChunkMetadata): ChunkDecision {
  if (chunk.byteLength > 2_000_000) return { kind: 'oversize' };
  if (chunk.sequence < history.nextExpected) {
    return {
      kind: history.acceptedHashes.get(chunk.sequence) === chunk.sha256 ? 'duplicate' : 'conflict',
    };
  }
  if (chunk.sequence > history.nextExpected) return { kind: 'future' };

  const acceptedHashes = new Map(history.acceptedHashes);
  acceptedHashes.set(chunk.sequence, chunk.sha256);
  return { kind: 'accept', nextExpected: history.nextExpected + 1, acceptedHashes };
}

/** outputDir is a server-owned, confined directory, passed as an argument without a shell. */
export function buildHlsArgs(outputDir: string): string[] {
  const directory = outputDir.replace(/[\\/]$/, '');
  return [
    '-y',
    '-fflags',
    '+genpts',
    '-f',
    'webm',
    '-i',
    'pipe:0',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-s',
    '1280x720',
    '-r',
    '24',
    '-b:v',
    '2500k',
    '-g',
    '96',
    '-sc_threshold',
    '0',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-ar',
    '48000',
    '-ac',
    '2',
    '-f',
    'hls',
    '-hls_time',
    '4',
    '-hls_playlist_type',
    'event',
    '-hls_flags',
    'independent_segments',
    '-hls_segment_filename',
    `${directory}/segment%06d.ts`,
    `${directory}/index.m3u8`,
  ];
}
