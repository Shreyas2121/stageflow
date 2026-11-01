import {
  isUuid,
  isRoomSlug,
  parseRoomTitle,
  parseDisplayName,
  type CreateRoomRequest,
  type RoomResponse,
} from '@stageflow/shared';
import { request } from '../../lib/http/client';
import { ApiError } from '../../lib/http/api-error';
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
