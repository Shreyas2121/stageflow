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
