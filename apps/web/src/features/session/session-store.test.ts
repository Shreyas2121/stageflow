import type { RoomResponse } from '@stageflow/shared';
import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionStore, expiresAt, isHostSession, readStoredSession } from './session-store';
import { createGuest } from './api';
import { createRoom, getRoom, parseRoom } from '../rooms/api';
import { bindSessionCache, roomQueryOptions } from '../rooms/query-options';

const guest = {
  userId: '550e8400-e29b-41d4-a716-446655440000',
  displayName: 'Ada',
  token: 'first-token',
};
const room: RoomResponse = {
  id: '550e8400-e29b-41d4-a716-446655440001',
  slug: 'ABCDEFGHIJKL',
  title: 'Review',
  mode: 'MEETING',
  status: 'LIVE',
  scheduledStartAt: null,
  requireAdmission: false,
  hostId: guest.userId,
  hostDisplayName: 'Ada',
  createdAt: '2026-11-01T00:00:00.000Z',
  endedAt: null,
};
beforeEach(() => {
  vi.stubEnv('VITE_API_BASE_URL', 'http://localhost:4000');
  vi.stubGlobal('sessionStorage', {
    getItem: vi.fn(() => null),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  });
});
afterEach(() => {
  useSessionStore.getState().clearSession();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('host copy and replacement sessions', () => {
  it.each([
    { payload: { guest: false }, host: true },
    { payload: { guest: true }, host: false },
    { payload: {}, host: false },
    { payload: { guest: 'false' }, host: false },
    { payload: { guest: 0 }, host: false },
    { payload: { guest: null }, host: false },
    { payload: null, host: false },
    { payload: [], host: false },
    { payload: false, host: false },
  ])('uses host copy only for boolean guest=false in $payload', ({ payload, host }) => {
    const token = `header.${btoa(JSON.stringify(payload))}.signature`;
    expect(isHostSession({ ...guest, token })).toBe(host);
  });

  it('treats a signed-out, malformed, or opaque session as a guest for copy', () => {
    expect(isHostSession(null)).toBe(false);
    for (const token of ['opaque', 'header.%%%.signature', `header.${btoa('{')}.signature`])
      expect(isHostSession({ ...guest, token })).toBe(false);
  });

  it('stores and restores a seven-day host session and clears it on logout', () => {
    const token = `header.${btoa(JSON.stringify({ guest: false, exp: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60 }))}.signature`;
    const host = { ...guest, token };
    useSessionStore.getState().setSession(host);
    expect(sessionStorage.setItem).toHaveBeenCalledWith('stageflow.session', JSON.stringify(host));
    vi.mocked(sessionStorage.getItem).mockReturnValue(JSON.stringify(host));
    expect(readStoredSession()).toEqual(host);
    expect(isHostSession(readStoredSession())).toBe(true);
    useSessionStore.getState().clearSession();
    expect(useSessionStore.getState().session).toBeNull();
    expect(sessionStorage.removeItem).toHaveBeenCalledWith('stageflow.session');
  });

  it('invalidates private caches on same-user promotion and password replacement', () => {
    const client = new QueryClient();
    useSessionStore.getState().setSession(guest);
    const unbind = bindSessionCache(client);
    try {
      for (const sv of [1, 2]) {
        client.setQueryData(['private', guest.userId, 'rooms'], 'old rooms');
        client.setQueryData(['public'], 'keep');
        const token = `header.${btoa(JSON.stringify({ guest: false, sv }))}.signature`;
        useSessionStore.getState().setSession({ ...guest, token });
        expect(client.getQueryCache().findAll({ queryKey: ['private'] })).toHaveLength(0);
        expect(client.getQueryData(['public'])).toBe('keep');
        useSessionStore.getState().clearSession(guest.token);
        expect(useSessionStore.getState().session?.token).toBe(token);
      }
    } finally {
      unbind();
      client.clear();
    }
  });
});
describe('guest recovery and private queries', () => {
  it('restores valid storage and discards corrupt or expired storage', () => {
    vi.mocked(sessionStorage.getItem).mockReturnValue(JSON.stringify(guest));
    expect(readStoredSession()).toEqual(guest);
    vi.mocked(sessionStorage.getItem).mockReturnValue('{');
    expect(readStoredSession()).toBeNull();
    const token = `header.${btoa(JSON.stringify({ exp: 1 }))}.signature`;
    vi.mocked(sessionStorage.getItem).mockReturnValue(JSON.stringify({ ...guest, token }));
    expect(readStoredSession()).toBeNull();
    expect(sessionStorage.removeItem).toHaveBeenCalledWith('stageflow.session');
  });
  it('continues in memory when storage denies both writes and removal', () => {
    vi.stubGlobal('sessionStorage', {
      setItem: () => {
        throw new Error('Denied');
      },
      removeItem: () => {
        throw new Error('Denied');
      },
    });
    expect(() => useSessionStore.getState().setSession(guest)).not.toThrow();
    expect(useSessionStore.getState().session).toEqual(guest);
    expect(() => useSessionStore.getState().clearSession()).not.toThrow();
    expect(useSessionStore.getState().session).toBeNull();
  });
  it('clears an unauthorized session while preserving the HTTP error', async () => {
    useSessionStore.getState().setSession(guest);
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ error: 'unauthorized', message: 'Enter your name' }, { status: 401 }),
        ),
    );
    await expect(getRoom(room.slug, guest.token)).rejects.toMatchObject({
      status: 401,
      code: 'unauthorized',
    });
    expect(useSessionStore.getState().session).toBeNull();
    // The name flow can immediately issue and store a fresh guest.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(Response.json({ ...guest, token: 'replacement' })),
    );
    useSessionStore.getState().setSession(await createGuest('Ada'));
    expect(useSessionStore.getState().session?.token).toBe('replacement');
  });
  it('does not clear a newer session when an old request returns 401', async () => {
    useSessionStore.getState().setSession({ ...guest, token: 'new-token' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 401 })));
    await expect(getRoom(room.slug, guest.token)).rejects.toMatchObject({ status: 401 });
    expect(useSessionStore.getState().session?.token).toBe('new-token');
  });
  it('expires tokens locally without inventing a lifetime for opaque tokens', () => {
    vi.useFakeTimers();
    const token = `header.${btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 2 }))}.signature`;
    useSessionStore.getState().setSession({ ...guest, token });
    expect(useSessionStore.getState().session).not.toBeNull();
    vi.advanceTimersByTime(2001);
    expect(useSessionStore.getState().session).toBeNull();
    expect(expiresAt('opaque-token')).toBeNull();
    useSessionStore.getState().setSession({ ...guest, token });
    expect(useSessionStore.getState().session).toBeNull();
  });
  it('removes private caches on replacement and clear, preserving public data', () => {
    const client = new QueryClient();
    const unbind = bindSessionCache(client);
    client.setQueryData(['public'], 'keep');
    client.setQueryData(['private', guest.userId, 'room', room.slug], room);
    useSessionStore.getState().setSession(guest);
    expect(client.getQueryCache().findAll({ queryKey: ['private'] })).toHaveLength(0);
    const options = roomQueryOptions(room.slug, guest);
    expect(options.queryKey).toContain(guest.userId);
    expect(JSON.stringify(options.queryKey)).not.toContain(guest.token);
    client.setQueryData(options.queryKey, room);
    useSessionStore.getState().clearSession();
    expect(client.getQueryData(options.queryKey)).toBeUndefined();
    expect(client.getQueryData(['public'])).toBe('keep');
    unbind();
    client.clear();
  });
  it('cancels a pending private query on identity replacement', async () => {
    const client = new QueryClient();
    useSessionStore.getState().setSession(guest);
    const unbind = bindSessionCache(client);
    let signal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            signal = init.signal ?? undefined;
            signal?.addEventListener('abort', () => reject(signal?.reason));
          }),
      ),
    );
    const pending = client.fetchQuery(roomQueryOptions(room.slug, guest));
    const rejection = expect(pending).rejects.toBeDefined();
    useSessionStore.getState().setSession({ ...guest, userId: room.id, token: 'next' });
    await rejection;
    expect(signal?.aborted).toBe(true);
    expect(client.getQueryCache().findAll({ queryKey: ['private'] })).toHaveLength(0);
    unbind();
    client.clear();
  });
  it('creates a fresh guest for create and join workflows and parses room responses', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json(guest))
      .mockResolvedValueOnce(Response.json(room))
      .mockResolvedValueOnce(Response.json({ ...guest, userId: room.id, token: 'next' }))
      .mockResolvedValueOnce(Response.json(room));
    vi.stubGlobal('fetch', fetch);
    const first = await createGuest('Ada');
    expect(await createRoom({ title: room.title, mode: 'MEETING' }, first.token)).toEqual(room);
    const second = await createGuest('Ada');
    expect(await getRoom(room.slug, second.token)).toEqual(room);
    expect(second.userId).not.toBe(first.userId);
    expect(fetch.mock.calls.map((call) => call[0])).toEqual([
      'http://localhost:4000/sessions/guest',
      'http://localhost:4000/rooms',
      'http://localhost:4000/sessions/guest',
      `http://localhost:4000/rooms/${room.slug}`,
    ]);
    expect(() => parseRoom({ ...room, mode: 'OTHER' })).toThrow();
    expect(() => parseRoom({ ...room, endedAt: 1 })).toThrow();
  });
});
