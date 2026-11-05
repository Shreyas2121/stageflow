import { ApiError } from '../../lib/http/api-error';
import { request } from '../../lib/http/client';
import { useSessionStore } from './session-store';

/** JSON requests only; media downloads and chunk uploads retain their own protocols. */
export async function authenticatedRequest<T>(
  path: string,
  token: string,
  parse: (body: unknown) => T,
  options: Omit<RequestInit, 'headers'> & { headers?: Record<string, string> } = {},
): Promise<T> {
  try {
    return await request(path, parse, {
      ...options,
      headers: { ...options.headers, Authorization: `Bearer ${token}` },
    });
  } catch (error) {
    if (error instanceof ApiError && error.status === 401)
      useSessionStore.getState().clearSession(token);
    throw error;
  }
}
