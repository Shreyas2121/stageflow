import {
  isUuid,
  isRoomSlug,
  parseHistoryCursor,
  parseRoomTitle,
  parseDisplayName,
  type BroadcastResponse,
  type CreateRoomRequest,
  type RoomResponse,
} from '@stageflow/shared';
import { request } from '../../lib/http/client';
import { ApiError } from '../../lib/http/api-error';
import { parseBroadcast } from '../broadcast/api';
import { useSessionStore } from '../session/session-store';

function date(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}
export function parseRoom(body: unknown): RoomResponse {
  if (
    typeof body !== 'object' ||
    body === null ||
    !('id' in body) ||
    !isUuid(body.id) ||
    !('slug' in body) ||
    !isRoomSlug(body.slug) ||
    !('title' in body) ||
    typeof body.title !== 'string' ||
    !parseRoomTitle(body.title).ok ||
    !('mode' in body) ||
    (body.mode !== 'MEETING' && body.mode !== 'WEBINAR') ||
    !('status' in body) ||
    (body.status !== 'LIVE' && body.status !== 'ENDED') ||
    !('hostId' in body) ||
    !isUuid(body.hostId) ||
    !('hostDisplayName' in body) ||
    typeof body.hostDisplayName !== 'string' ||
    !parseDisplayName(body.hostDisplayName).ok ||
    !('createdAt' in body) ||
    !date(body.createdAt) ||
    !('endedAt' in body) ||
    (body.endedAt !== null && !date(body.endedAt))
  )
    throw new Error('Invalid room');
  return {
    id: body.id,
    slug: body.slug,
    title: body.title,
    mode: body.mode,
    status: body.status,
    hostId: body.hostId,
    hostDisplayName: body.hostDisplayName,
    createdAt: body.createdAt,
    endedAt: body.endedAt,
  };
}
async function roomRequest(
  path: string,
  token: string,
  options: RequestInit,
): Promise<RoomResponse> {
  try {
    return await request(path, parseRoom, {
      ...options,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    });
  } catch (error) {
    if (error instanceof ApiError && error.status === 401)
      useSessionStore.getState().clearSession(token);
    throw error;
  }
}
export function createRoom(
  input: CreateRoomRequest,
  token: string,
  signal?: AbortSignal,
): Promise<RoomResponse> {
  return roomRequest('/rooms', token, { method: 'POST', body: JSON.stringify(input), signal });
}
export function getRoom(slug: string, token: string, signal?: AbortSignal): Promise<RoomResponse> {
  return roomRequest(`/rooms/${encodeURIComponent(slug)}`, token, { signal });
}

export type RoomPage = {
  items: RoomResponse[];
  nextCursor: string | null;
};

export type BroadcastPage = {
  items: BroadcastResponse[];
  nextCursor: string | null;
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseNextCursor(value: unknown, invalid: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') throw new Error(invalid);
  const parsed = parseHistoryCursor(value);
  if (!parsed.ok || parsed.value === null) throw new Error(invalid);
  return value;
}

function parseRoomPage(body: unknown, userId: string): RoomPage {
  if (!record(body) || !Array.isArray(body.items) || !('nextCursor' in body))
    throw new Error('Invalid room page');
  const items = body.items.map((item) => parseRoom(item));
  if (items.some((item) => item.hostId !== userId)) throw new Error('Invalid room page');
  return { items, nextCursor: parseNextCursor(body.nextCursor, 'Invalid room page') };
}

function parseBroadcastPage(body: unknown): BroadcastPage {
  if (!record(body) || !Array.isArray(body.items) || !('nextCursor' in body))
    throw new Error('Invalid broadcast page');
  return {
    items: body.items.map((item) => parseBroadcast(item)),
    nextCursor: parseNextCursor(body.nextCursor, 'Invalid broadcast page'),
  };
}

function catalogPath(path: string, cursor: string | null): string {
  if (!cursor) return path;
  return `${path}?${new URLSearchParams({ cursor }).toString()}`;
}

async function authorized<T>(
  path: string,
  token: string,
  parse: (body: unknown) => T,
  signal?: AbortSignal,
): Promise<T> {
  try {
    return await request(path, parse, {
      signal,
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (error) {
    if (error instanceof ApiError && error.status === 401)
      useSessionStore.getState().clearSession(token);
    throw error;
  }
}

export function listRooms(
  token: string,
  cursor: string | null,
  signal?: AbortSignal,
): Promise<RoomPage> {
  const session = useSessionStore.getState().session;
  if (!session || session.token !== token) throw new Error('Invalid room page');
  const userId = session.userId;
  return authorized(
    catalogPath('/rooms', cursor),
    token,
    (body) => parseRoomPage(body, userId),
    signal,
  );
}

export function listBroadcasts(
  slug: string,
  token: string,
  cursor: string | null,
  signal?: AbortSignal,
): Promise<BroadcastPage> {
  return authorized(
    catalogPath(`/rooms/${encodeURIComponent(slug)}/broadcasts`, cursor),
    token,
    parseBroadcastPage,
    signal,
  );
}
