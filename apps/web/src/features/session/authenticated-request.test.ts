import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authenticatedRequest } from './authenticated-request';
import { useSessionStore } from './session-store';

const guest = {
  userId: '550e8400-e29b-41d4-a716-446655440000',
  displayName: 'Ava',
  token: 'old-token',
};

beforeEach(() => {
  vi.stubEnv('VITE_API_BASE_URL', 'http://localhost:4000/api');
});

afterEach(() => {
  useSessionStore.getState().clearSession();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('authenticated JSON requests', () => {
  it('keeps a replacement session when an old request later returns 401', async () => {
    useSessionStore.getState().setSession(guest);
    let release!: (response: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            release = resolve;
          }),
      ),
    );
    const pending = authenticatedRequest('/rooms', guest.token, (body) => body);
    const replacement = { ...guest, token: 'new-token' };
    useSessionStore.getState().setSession(replacement);
    release(Response.json({ message: 'expired' }, { status: 401 }));
    await expect(pending).rejects.toMatchObject({ status: 401 });
    expect(useSessionStore.getState().session).toEqual(replacement);
  });

  it('preserves JSON options, bearer headers, parsing, and caller cancellation', async () => {
    const controller = new AbortController();
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      controller.abort(new Error('cancelled'));
      expect(init.signal?.aborted).toBe(true);
      return Response.json({ value: 'late' });
    });
    vi.stubGlobal('fetch', fetch);
    const parse = vi.fn();
    await expect(
      authenticatedRequest('/rooms', guest.token, parse, {
        method: 'POST',
        body: '{}',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
      }),
    ).rejects.toThrow('cancelled');
    expect(fetch).toHaveBeenCalledWith(
      'http://localhost:4000/api/rooms',
      expect.objectContaining({
        method: 'POST',
        body: '{}',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer old-token' },
      }),
    );
    expect(parse).not.toHaveBeenCalled();
  });

  it('retains the session on a parser failure', async () => {
    useSessionStore.getState().setSession(guest);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ invalid: true })),
    );
    await expect(
      authenticatedRequest('/rooms', guest.token, () => {
        throw new Error('schema');
      }),
    ).rejects.toMatchObject({ code: 'invalid_response' });
    expect(useSessionStore.getState().session).toEqual(guest);
  });
});
