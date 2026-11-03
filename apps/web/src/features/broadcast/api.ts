import { parseBroadcast as readBroadcast, type BroadcastResponse } from '@stageflow/shared';
import { request } from '../../lib/http/client';
import { ApiError } from '../../lib/http/api-error';
import { useSessionStore } from '../session/session-store';

export type BroadcastDetails = BroadcastResponse;

export function parseBroadcast(body: unknown): BroadcastDetails {
  const parsed = readBroadcast(body);
  if (!parsed) throw new Error('Invalid broadcast');
  return parsed;
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
