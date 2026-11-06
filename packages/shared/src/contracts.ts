import { isRoomSlug } from './identifiers';
import { DISPLAY_NAME_MAX_LENGTH, ROOM_TITLE_MAX_LENGTH } from './limits';
export { createRoomSlug, createRoomSlugFromCrypto } from './identifiers';
export type RoomMode = 'MEETING' | 'WEBINAR';
export type RoomStatus = 'SCHEDULED' | 'LIVE' | 'ENDED';

/** Canonical UTC instant; advertised times may be in the past. */
export function isScheduledStartAt(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    return false;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

export type GuestSessionResponse = {
  token: string;
  userId: string;
  displayName: string;
};

export type CreateRoomRequest = {
  title: string;
  mode: RoomMode;
  status?: 'LIVE' | 'SCHEDULED';
  scheduledStartAt?: string;
  requireAdmission?: boolean;
};

export type RoomResponse = {
  id: string;
  slug: string;
  title: string;
  mode: RoomMode;
  status: RoomStatus;
  scheduledStartAt: string | null;
  requireAdmission: boolean;
  hostId: string;
  hostDisplayName: string;
  createdAt: string;
  endedAt: string | null;
};

export type ApiErrorBody = {
  statusCode: number;
  error:
    | 'invalid_display_name'
    | 'invalid_email'
    | 'invalid_password'
    | 'email_taken'
    | 'not_guest'
    | 'not_registered'
    | 'membership_active'
    | 'wrong_password'
    | 'google_unavailable'
    | 'google_rejected'
    | 'google_linked'
    | 'google_host_required'
    | 'password_not_set'
    | 'invalid_title'
    | 'invalid_mode'
    | 'schedule_not_allowed'
    | 'invalid_schedule'
    | 'invalid_admission'
    | 'invalid_page'
    | 'invalid_cursor'
    | 'invalid_room_link'
    | 'unauthorized'
    | 'room_not_found'
    | 'invalid_visibility'
    | 'replay_owner_required'
    | 'broadcast_not_ready'
    | 'broadcast_not_deletable'
    | 'broadcast_delete_failed'
    | 'broadcast_not_found'
    | 'broadcast_not_active'
    | 'storage_full'
    | 'recording_limit'
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

/** `isGuest` comes from the verified caller, never the request body. */
export function parseCreateRoomRequest(
  input: unknown,
  isGuest: boolean,
): ParseResult<{
  title: string;
  mode: RoomMode;
  status: 'LIVE' | 'SCHEDULED';
  scheduledStartAt: string | null;
  requireAdmission: boolean;
}> {
  const body =
    typeof input === 'object' && input !== null && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  if (isGuest && ['status', 'scheduledStartAt', 'requireAdmission'].some((key) => key in body)) {
    return {
      ok: false,
      error: 'schedule_not_allowed',
      message: 'Create a host account before scheduling a room.',
    };
  }
  const title = parseRoomTitle(body.title);
  if (!title.ok) return title;
  const mode = parseRoomMode(body.mode);
  if (!mode.ok) return mode;
  const status = 'status' in body ? body.status : 'LIVE';
  if (status !== 'LIVE' && status !== 'SCHEDULED') {
    return { ok: false, error: 'invalid_schedule', message: 'Choose a live or scheduled room.' };
  }
  if (
    (status === 'SCHEDULED' && !isScheduledStartAt(body.scheduledStartAt)) ||
    (status === 'LIVE' && 'scheduledStartAt' in body)
  ) {
    return { ok: false, error: 'invalid_schedule', message: 'Enter a UTC start time.' };
  }
  const requireAdmission = 'requireAdmission' in body ? body.requireAdmission : false;
  if (typeof requireAdmission !== 'boolean') {
    return {
      ok: false,
      error: 'invalid_admission',
      message: 'Choose whether host admission is required.',
    };
  }
  if (mode.value === 'WEBINAR' && requireAdmission) {
    return {
      ok: false,
      error: 'invalid_admission',
      message: 'Admission applies to meetings only.',
    };
  }
  return {
    ok: true,
    value: {
      title: title.value,
      mode: mode.value,
      status,
      scheduledStartAt: status === 'SCHEDULED' ? (body.scheduledStartAt as string) : null,
      requireAdmission,
    },
  };
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
