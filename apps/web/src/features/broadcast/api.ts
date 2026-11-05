import { parseBroadcast as readBroadcast, type BroadcastResponse } from '@stageflow/shared';
import { authenticatedRequest } from '../session/authenticated-request';

export type BroadcastDetails = BroadcastResponse;

export function parseBroadcast(body: unknown): BroadcastDetails {
  const parsed = readBroadcast(body);
  if (!parsed) throw new Error('Invalid broadcast');
  return parsed;
}

export function getBroadcast(
  id: string,
  token: string,
  signal?: AbortSignal,
): Promise<BroadcastDetails> {
  return authenticatedRequest(`/broadcasts/${encodeURIComponent(id)}`, token, parseBroadcast, {
    signal,
  });
}
