import { isRoomSlug } from './identifiers';
import { DISPLAY_NAME_MAX_LENGTH, ROOM_TITLE_MAX_LENGTH } from './limits';
export { createRoomSlug, createRoomSlugFromCrypto } from './identifiers';
export type RoomMode = 'MEETING' | 'WEBINAR';
export type RoomStatus = 'LIVE' | 'ENDED';

export type GuestSessionResponse = {
  token: string;
  userId: string;
  displayName: string;
};

export type CreateRoomRequest = {
  title: string;
  mode: RoomMode;
};

export type RoomResponse = {
  id: string;
  slug: string;
  title: string;
  mode: RoomMode;
  status: RoomStatus;
  hostId: string;
  hostDisplayName: string;
  createdAt: string;
  endedAt: string | null;
};

export type ApiErrorBody = {
  statusCode: number;
  error:
    | 'invalid_display_name'
    | 'invalid_title'
    | 'invalid_mode'
    | 'invalid_page'
    | 'invalid_cursor'
    | 'invalid_room_link'
    | 'unauthorized'
    | 'room_not_found'
    | 'broadcast_not_found'
    | 'broadcast_not_active'
    | 'invalid_chunk'
    | 'chunk_conflict'
    | 'media_not_found'
    | 'not_host'
    | 'slug_exhausted'
    | 'rate_limited'
    | 'server_busy'
    | 'origin_not_allowed';
  message: string;
};

export type ParseResult<T> =
  { ok: true; value: T } | { ok: false; error: ApiErrorBody['error']; message: string };

function parseText(
  input: unknown,
  maxLength: number,
  error: ApiErrorBody['error'],
  message: string,
): ParseResult<string> {
  if (typeof input !== 'string') return { ok: false, error, message };

  const value = input.trim();
  const hasControlCharacter = Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
  if (value.length === 0 || value.length > maxLength || hasControlCharacter) {
    return { ok: false, error, message };
  }

  return { ok: true, value };
}

export function parseDisplayName(input: unknown): ParseResult<string> {
  return parseText(
    input,
    DISPLAY_NAME_MAX_LENGTH,
    'invalid_display_name',
    'Enter a display name from 1 to 40 characters.',
  );
}

export function parseRoomTitle(input: unknown): ParseResult<string> {
  return parseText(
    input,
    ROOM_TITLE_MAX_LENGTH,
    'invalid_title',
    'Enter a title from 1 to 80 characters.',
  );
}

export function parseRoomMode(input: unknown): ParseResult<RoomMode> {
  if (input === 'MEETING' || input === 'WEBINAR') return { ok: true, value: input };
  return { ok: false, error: 'invalid_mode', message: 'Choose a meeting or a webinar.' };
}

const ROOM_LINK_MESSAGE = 'Enter a room slug or a link to a room on this app.';
/** Path-only values are resolved here so a rewrite cannot change the host. */
const ROOM_PATH_ORIGIN = 'https://room-link.invalid';

function invalidRoomLink(): ParseResult<string> {
  return { ok: false, error: 'invalid_room_link', message: ROOM_LINK_MESSAGE };
}

function hasRewrittenCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 32 || code === 127 || character === '\\';
  });
}

function slugFromRoomPath(pathname: string): string | null {
  const prefix = '/r/';
  if (!pathname.startsWith(prefix)) return null;
  const slug = pathname.slice(prefix.length);
  return isRoomSlug(slug) ? slug : null;
}

function parseRoomPath(value: string): ParseResult<string> {
  if (value.startsWith('//')) return invalidRoomLink();
  try {
    const url = new URL(value, ROOM_PATH_ORIGIN);
    if (url.origin !== ROOM_PATH_ORIGIN || url.pathname !== value || url.search || url.hash) {
      return invalidRoomLink();
    }
    if (url.username || url.password) return invalidRoomLink();
    const slug = slugFromRoomPath(url.pathname);
    if (!slug) return invalidRoomLink();
    return { ok: true, value: slug };
  } catch {
    return invalidRoomLink();
  }
}

function parseAbsoluteRoomLink(value: string, origin: string): ParseResult<string> {
  try {
    const allowed = new URL(origin);
    if (
      (allowed.protocol !== 'http:' && allowed.protocol !== 'https:') ||
      allowed.origin !== origin
    ) {
      return invalidRoomLink();
    }
    const url = new URL(value);
    if (url.href !== value || url.origin !== allowed.origin) return invalidRoomLink();
    if (url.username || url.password || url.search || url.hash) return invalidRoomLink();
    const slug = slugFromRoomPath(url.pathname);
    if (!slug) return invalidRoomLink();
    return { ok: true, value: slug };
  } catch {
    return invalidRoomLink();
  }
}

/** Trimmed slug, `/r/{slug}`, or an http(s) URL whose origin equals `origin`. The result is the slug. */
export function parseRoomJoinTarget(input: unknown, origin: string): ParseResult<string> {
  if (typeof input !== 'string') return invalidRoomLink();
  const value = input.trim();
  const slug = isRoomSlug(value) ? value : null;
  if (slug) return { ok: true, value: slug };
  if (value.length === 0 || hasRewrittenCharacter(value)) return invalidRoomLink();
  if (value.startsWith('/')) return parseRoomPath(value);
  if (value.startsWith('http://') || value.startsWith('https://')) {
    return parseAbsoluteRoomLink(value, origin);
  }
  return invalidRoomLink();
}
