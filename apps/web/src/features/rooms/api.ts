import {
  isUuid,
  isScheduledStartAt,
  isRoomSlug,
  parseHistoryCursor,
  parseRoomTitle,
  parseDisplayName,
  type BroadcastResponse,
  type BroadcastVisibility,
  type CreateRoomRequest,
  type RoomResponse,
} from '@stageflow/shared';
import { authenticatedRequest } from '../session/authenticated-request';
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
    (body.status !== 'SCHEDULED' && body.status !== 'LIVE' && body.status !== 'ENDED') ||
    !('scheduledStartAt' in body) ||
    (body.scheduledStartAt !== null && !isScheduledStartAt(body.scheduledStartAt)) ||
    !('requireAdmission' in body) ||
    typeof body.requireAdmission !== 'boolean' ||
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
    scheduledStartAt: body.scheduledStartAt,
    requireAdmission: body.requireAdmission,
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
  return authenticatedRequest(path, token, parseRoom, {
    ...options,
    headers: { 'Content-Type': 'application/json' },
  });
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

export function listRooms(
  token: string,
  cursor: string | null,
  signal?: AbortSignal,
): Promise<RoomPage> {
  const session = useSessionStore.getState().session;
  if (!session || session.token !== token) throw new Error('Invalid room page');
  const userId = session.userId;
  return authenticatedRequest(
    catalogPath('/rooms', cursor),
    token,
    (body) => parseRoomPage(body, userId),
    { signal },
  );
}

export function listBroadcasts(
  slug: string,
  token: string,
  cursor: string | null,
  signal?: AbortSignal,
): Promise<BroadcastPage> {
  return authenticatedRequest(
    catalogPath(`/rooms/${encodeURIComponent(slug)}/broadcasts`, cursor),
    token,
    parseBroadcastPage,
    { signal },
  );
}

export function setBroadcastVisibility(
  id: string,
  visibility: BroadcastVisibility,
  token: string,
  signal?: AbortSignal,
): Promise<BroadcastResponse> {
  return authenticatedRequest(
    `/broadcasts/${encodeURIComponent(id)}/visibility`,
    token,
    parseBroadcast,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visibility }),
      signal,
    },
  );
}

export function deleteBroadcast(id: string, token: string, signal?: AbortSignal): Promise<void> {
  return authenticatedRequest(
    `/broadcasts/${encodeURIComponent(id)}`,
    token,
    (body) => {
      if (body !== undefined) throw new Error('Expected an empty delete response');
    },
    { method: 'DELETE', signal },
  );
}
