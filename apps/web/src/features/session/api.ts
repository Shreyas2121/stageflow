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

function accountRequest(
  route: string,
  body: Record<string, string>,
  signal?: AbortSignal,
  token?: string,
): Promise<GuestSessionResponse> {
  return request(`/sessions/${route}`, parseGuest, {
    method: 'POST',
    ...(route.startsWith('google/') ? { credentials: 'include' as const } : {}),
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    signal,
  });
}

export function register(
  displayName: string,
  email: string,
  password: string,
  signal?: AbortSignal,
): Promise<GuestSessionResponse> {
  return accountRequest('register', { displayName, email, password }, signal);
}

export function login(
  email: string,
  password: string,
  signal?: AbortSignal,
): Promise<GuestSessionResponse> {
  return accountRequest('login', { email, password }, signal);
}

export function promote(
  email: string,
  password: string,
  token: string,
  signal?: AbortSignal,
): Promise<GuestSessionResponse> {
  return accountRequest('promote', { email, password }, signal, token);
}

export function changePassword(
  currentPassword: string,
  password: string,
  token: string,
  signal?: AbortSignal,
): Promise<GuestSessionResponse> {
  return accountRequest('password', { currentPassword, password }, signal, token);
}

export async function googleEnabled(signal?: AbortSignal): Promise<boolean> {
  try {
    return await request(
      '/sessions/google',
      (body) => {
        if (
          !body ||
          typeof body !== 'object' ||
          Array.isArray(body) ||
          Object.keys(body).length !== 1 ||
          !('enabled' in body) ||
          typeof body.enabled !== 'boolean'
        )
          return false;
        return body.enabled;
      },
      { signal },
    );
  } catch {
    return false;
  }
}

export function redeemGoogleTicket(ticket: string, token?: string): Promise<GuestSessionResponse> {
  return accountRequest('google/ticket', { ticket }, undefined, token);
}

export function linkGoogle(token: string, signal?: AbortSignal): Promise<string> {
  return request(
    '/sessions/google/link',
    (body) => {
      if (!body || typeof body !== 'object' || !('url' in body) || typeof body.url !== 'string')
        throw new Error('Invalid Google link');
      const url = new URL(body.url);
      if (
        url.protocol !== 'https:' ||
        url.hostname !== 'accounts.google.com' ||
        url.username ||
        url.password ||
        url.port
      )
        throw new Error('Invalid Google link');
      return url.href;
    },
    {
      method: 'POST',
      credentials: 'include',
      headers: { Authorization: `Bearer ${token}` },
      signal,
    },
  );
}
