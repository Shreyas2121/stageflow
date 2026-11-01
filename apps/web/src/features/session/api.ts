import { isUuid, parseDisplayName, type GuestSessionResponse } from '@stageflow/shared';
import { request } from '../../lib/http/client';

export function parseGuest(body: unknown): GuestSessionResponse {
  if (
    typeof body !== 'object' ||
    body === null ||
    !('token' in body) ||
    typeof body.token !== 'string' ||
    !body.token ||
    !('userId' in body) ||
    !isUuid(body.userId) ||
    !('displayName' in body) ||
    !parseDisplayName(body.displayName).ok ||
    typeof body.displayName !== 'string'
  )
    throw new Error('Invalid guest session');
  return { token: body.token, userId: body.userId, displayName: body.displayName };
}
export function createGuest(
  displayName: string,
  signal?: AbortSignal,
): Promise<GuestSessionResponse> {
  return request('/sessions/guest', parseGuest, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName }),
    signal,
  });
}
