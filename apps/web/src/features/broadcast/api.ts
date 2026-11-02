import { isUuid, type BroadcastStatus } from '@stageflow/shared';
import { request } from '../../lib/http/client';
import { ApiError } from '../../lib/http/api-error';
import { useSessionStore } from '../session/session-store';

const statuses = new Set<string>(['STARTING', 'LIVE', 'STOPPING', 'READY', 'FAILED']);

function isStatus(value: unknown): value is BroadcastStatus {
  return typeof value === 'string' && statuses.has(value);
}
function isDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}
function isOptionalText(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}
function isPlaylistUrl(value: unknown): value is string | null {
  return (
    value === null ||
    (typeof value === 'string' && (value.startsWith('/') || /^https?:\/\//i.test(value)))
  );
}

export type BroadcastDetails = {
  id: string;
  roomId: string;
  status: BroadcastStatus;
  playlistUrl: string | null;
  errorMessage: string | null;
  startedAt: string;
  endedAt: string | null;
  createdAt: string;
};

export function parseBroadcast(body: unknown): BroadcastDetails {
  if (
    typeof body !== 'object' ||
    body === null ||
    !('id' in body) ||
    !isUuid(body.id) ||
    !('roomId' in body) ||
    !isUuid(body.roomId) ||
    !('status' in body) ||
    !isStatus(body.status) ||
    !('playlistUrl' in body) ||
    !isPlaylistUrl(body.playlistUrl) ||
    !('playlistPath' in body) ||
    !isOptionalText(body.playlistPath) ||
    !('thumbnailPath' in body) ||
    !isOptionalText(body.thumbnailPath) ||
    !('errorMessage' in body) ||
    !isOptionalText(body.errorMessage) ||
    !('startedAt' in body) ||
    !isDate(body.startedAt) ||
    !('endedAt' in body) ||
    (body.endedAt !== null && !isDate(body.endedAt)) ||
    !('createdAt' in body) ||
    !isDate(body.createdAt)
  )
    throw new Error('Invalid broadcast');
  return {
    id: body.id,
    roomId: body.roomId,
    status: body.status,
    playlistUrl: body.playlistUrl,
    errorMessage: body.errorMessage,
    startedAt: body.startedAt,
    endedAt: body.endedAt,
    createdAt: body.createdAt,
  };
}

async function broadcastRequest(path: string, token: string, signal?: AbortSignal) {
  try {
    return await request(path, parseBroadcast, {
      signal,
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (error) {
    if (error instanceof ApiError && error.status === 401)
      useSessionStore.getState().clearSession(token);
    throw error;
  }
}

export function getBroadcast(
  id: string,
  token: string,
  signal?: AbortSignal,
): Promise<BroadcastDetails> {
  return broadcastRequest(`/broadcasts/${encodeURIComponent(id)}`, token, signal);
}
