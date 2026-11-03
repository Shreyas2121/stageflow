import { isUuid } from './identifiers';

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

export type ChunkDecision = { kind: 'accept' | 'duplicate' | 'conflict' | 'future' | 'oversize' };

/** Pure decision: the owner appends the hash and advances only after a successful write. */
export function acceptChunk(history: ChunkHistory, chunk: ChunkMetadata): ChunkDecision {
  if (chunk.byteLength > 2_000_000) return { kind: 'oversize' };
  if (chunk.sequence < history.nextExpected) {
    return {
      kind: history.acceptedHashes.get(chunk.sequence) === chunk.sha256 ? 'duplicate' : 'conflict',
    };
  }
  if (chunk.sequence > history.nextExpected) return { kind: 'future' };

  return { kind: 'accept' };
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

/**
 * Public GET catalog object. `playlistPath` and `thumbnailPath` stay on the stored row and are
 * not part of this response. Clients use `playlistUrl` or null, and `thumbnailUrl` or null.
 * There is no second wire format.
 *
 * A non-null playlist is only `/api/broadcasts/{uuid}/hls/index.m3u8`. A non-null thumbnail is
 * only `/api/broadcasts/{id}/thumbnail.jpg` for that same id. Absolute, protocol-relative, and
 * cross-origin URLs are rejected. They are not a supported CDN mode, and the guest bearer token
 * must not be attached to them or to any other destination. Segment names are loaded from that
 * playlist; they are not catalog fields. Credentials may also be sent for a same-origin `segment`
 * plus at least six digits and `.ts` under that broadcast.
 */
const BROADCAST_ERROR_MESSAGE_MAX = 2000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const PLAYLIST_PATH = new RegExp(`^/api/broadcasts/(${UUID})/hls/index\\.m3u8$`);
const MEDIA_PATH = new RegExp(`^/api/broadcasts/(${UUID})/hls/(index\\.m3u8|segment\\d{6,}\\.ts)$`);
const statuses = new Set<string>(['STARTING', 'LIVE', 'STOPPING', 'READY', 'FAILED']);

export type BroadcastResponse = {
  id: string;
  roomId: string;
  status: BroadcastStatus;
  playlistUrl: string | null;
  thumbnailUrl: string | null;
  errorMessage: string | null;
  startedAt: string;
  endedAt: string | null;
  createdAt: string;
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBroadcastStatus(value: unknown): value is BroadcastStatus {
  return typeof value === 'string' && statuses.has(value);
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function isErrorMessage(value: unknown): value is string | null {
  return (
    value === null || (typeof value === 'string' && value.length <= BROADCAST_ERROR_MESSAGE_MAX)
  );
}

/** Catalog playlist path, or null when `id` is not a UUID. The stored filesystem path is never copied. */
export function broadcastPlaylistUrl(id: string): string | null {
  if (!isUuid(id)) return null;
  return `/api/broadcasts/${id}/hls/index.m3u8`;
}

/** Catalog thumbnail path, or null when `id` is not a UUID. The stored filesystem path is never copied. */
export function broadcastThumbnailUrl(id: string): string | null {
  if (!isUuid(id)) return null;
  return `/api/broadcasts/${id}/thumbnail.jpg`;
}

/** True only for the catalog playlist path. Absolute URLs are not catalog values. */
export function isBroadcastPlaylistUrl(value: string): boolean {
  const match = PLAYLIST_PATH.exec(value);
  return match !== null && isUuid(match[1]);
}

function isBroadcastMediaPath(value: string): boolean {
  const match = MEDIA_PATH.exec(value);
  return match !== null && isUuid(match[1]);
}

function isCatalogPlaylist(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && isBroadcastPlaylistUrl(value));
}

function isCatalogThumbnail(id: string, value: unknown): value is string | null {
  return value === null || value === broadcastThumbnailUrl(id);
}

/**
 * Absolute URL that may receive the guest bearer token.
 * `apiBase` may include a path; only its origin is used. The resource must already be the catalog
 * playlist or one of its segments. Any other origin, query, hash, or path returns null.
 */
export function resolveBroadcastMediaUrl(resource: string, apiBase: string): string | null {
  if (typeof resource !== 'string' || typeof apiBase !== 'string') return null;
  // eslint-disable-next-line no-control-regex -- Reject control characters before URL normalization.
  if (/[\u0000-\u0020\\]/.test(resource)) return null;
  try {
    const base = new URL(apiBase);
    if (base.protocol !== 'http:' && base.protocol !== 'https:') return null;
    const url = new URL(resource, base.origin);
    if (url.origin !== base.origin || url.username || url.password || url.search || url.hash)
      return null;
    if (!isBroadcastMediaPath(url.pathname)) return null;
    return url.href;
  } catch {
    return null;
  }
}

export function parseBroadcast(value: unknown): BroadcastResponse | null {
  if (
    !record(value) ||
    !isUuid(value.id) ||
    !isUuid(value.roomId) ||
    !isBroadcastStatus(value.status) ||
    !isCatalogPlaylist(value.playlistUrl) ||
    !isCatalogThumbnail(value.id, value.thumbnailUrl) ||
    !isErrorMessage(value.errorMessage) ||
    !isIsoDate(value.startedAt) ||
    !(value.endedAt === null || isIsoDate(value.endedAt)) ||
    !isIsoDate(value.createdAt)
  )
    return null;
  return {
    id: value.id,
    roomId: value.roomId,
    status: value.status,
    playlistUrl: value.playlistUrl,
    thumbnailUrl: value.thumbnailUrl,
    errorMessage: value.errorMessage,
    startedAt: value.startedAt,
    endedAt: value.endedAt,
    createdAt: value.createdAt,
  };
}
