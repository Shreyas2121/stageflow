import { encodeHistoryCursor } from '@stageflow/shared';
import { skipToken } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useSessionStore } from '../session/session-store';
import { listBroadcasts, listRooms } from './api';
import { roomBroadcastsQueryOptions, roomsQueryOptions } from './query-options';

const userId = '550e8400-e29b-41d4-a716-446655440000';
const otherId = '550e8400-e29b-41d4-a716-446655440099';
const token = 'guest-token';
const slug = 'Ab12Cd34Ef56';
const broadcastId = '11111111-1111-4111-8111-111111111111';
const encodedCursor = encodeHistoryCursor('2026-11-03T15:04:05.006Z', broadcastId);
if (!encodedCursor) throw new Error('Expected a history cursor.');
const cursor = encodedCursor;

function room(hostId = userId) {
  return {
    id: '550e8400-e29b-41d4-a716-446655440001',
    slug,
    title: 'Design review',
    mode: 'MEETING',
    status: 'LIVE',
    hostId,
    hostDisplayName: 'Ava',
    createdAt: '2026-11-03T15:04:05.006Z',
    endedAt: null,
  };
}

function broadcast() {
  return {
    id: broadcastId,
    roomId: '22222222-2222-4222-8222-222222222222',
    status: 'READY',
    playlistUrl: `/api/broadcasts/${broadcastId}/hls/index.m3u8`,
    thumbnailUrl: null,
    errorMessage: ' encoder missing ',
    startedAt: '2026-11-03T15:04:05.006Z',
    endedAt: '2026-11-03T15:05:05.006Z',
    createdAt: '2026-11-03T15:04:05.006Z',
  };
}

describe('guest catalog pages', () => {
  afterEach(() => {
    useSessionStore.setState({
      session: null,
    });
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('lists only this guest rooms without a host id or a limit', async () => {
    vi.stubEnv('VITE_API_BASE_URL', 'http://localhost:4000/api');
    useSessionStore.setState({ session: { token, userId, displayName: 'Ava' } });
    const fetchMock = vi.fn(() =>
      Promise.resolve(Response.json({ items: [room()], nextCursor: null })),
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(listRooms(token, null)).resolves.toMatchObject({
      items: [{ id: room().id, hostId: userId }],
      nextCursor: null,
    });
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      'http://localhost:4000/api/rooms',
      expect.objectContaining({ headers: { Authorization: `Bearer ${token}` } }),
    );
    const calls = fetchMock.mock.calls as unknown as Array<[string]>;
    const url = String(calls[0]?.[0]);
    expect(url).not.toContain('hostId');
    expect(url).not.toContain('limit');
  });

  it('sends only the cursor when a later room page is requested', async () => {
    vi.stubEnv('VITE_API_BASE_URL', 'http://localhost:4000/api');
    useSessionStore.setState({ session: { token, userId, displayName: 'Ava' } });
    const fetchMock = vi.fn(() => Promise.resolve(Response.json({ items: [], nextCursor: null })));
    vi.stubGlobal('fetch', fetchMock);
    await listRooms(token, cursor);
    const calls = fetchMock.mock.calls as unknown as Array<[string]>;
    const url = new URL(String(calls[0]?.[0]));
    expect(url.pathname).toBe('/api/rooms');
    expect(url.searchParams.get('cursor')).toBe(cursor);
    expect(url.searchParams.get('limit')).toBeNull();
    expect(url.searchParams.get('hostId')).toBeNull();
  });

  it('rejects a room page that includes another guest', async () => {
    vi.stubEnv('VITE_API_BASE_URL', 'http://localhost:4000/api');
    useSessionStore.setState({ session: { token, userId, displayName: 'Ava' } });
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(Response.json({ items: [room(), room(otherId)], nextCursor: null })),
      ),
    );
    await expect(listRooms(token, null)).rejects.toMatchObject({ code: 'invalid_response' });
    expect(useSessionStore.getState().session?.userId).toBe(userId);
  });

  it('clears the token when the room list returns 401', async () => {
    vi.stubEnv('VITE_API_BASE_URL', 'http://localhost:4000/api');
    useSessionStore.setState({ session: { token, userId, displayName: 'Ava' } });
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(Response.json({ message: 'Sign in again.' }, { status: 401 }))),
    );
    await expect(listRooms(token, null)).rejects.toMatchObject({ status: 401 });
    expect(useSessionStore.getState().session).toBeNull();
  });

  it('lists broadcast history for a room and keeps the cursor', async () => {
    vi.stubEnv('VITE_API_BASE_URL', 'http://localhost:4000/api');
    const fetchMock = vi.fn(() =>
      Promise.resolve(Response.json({ items: [broadcast()], nextCursor: cursor })),
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(listBroadcasts(slug, token, null)).resolves.toMatchObject({
      items: [{ id: broadcastId, status: 'READY', errorMessage: ' encoder missing ' }],
      nextCursor: cursor,
    });
    const calls = fetchMock.mock.calls as unknown as Array<[string]>;
    expect(calls[0]?.[0]).toBe(`http://localhost:4000/api/rooms/${slug}/broadcasts`);
    fetchMock.mockResolvedValueOnce(Response.json({ items: [], nextCursor: null }));
    await listBroadcasts(slug, token, cursor);
    const nextCalls = fetchMock.mock.calls as unknown as Array<[string]>;
    const url = new URL(String(nextCalls[1]?.[0]));
    expect(url.searchParams.get('cursor')).toBe(cursor);
    expect(url.searchParams.get('limit')).toBeNull();
  });

  it('keeps catalog queries private to the session user and skips them without a session', () => {
    const session = { token, userId, displayName: 'Ava' };
    expect(roomsQueryOptions(session, null).queryKey).toEqual(['private', userId, 'rooms', null]);
    expect(roomsQueryOptions(session, cursor).queryKey).toEqual([
      'private',
      userId,
      'rooms',
      cursor,
    ]);
    expect(roomBroadcastsQueryOptions(session, slug, cursor).queryKey).toEqual([
      'private',
      userId,
      'room-broadcasts',
      slug,
      cursor,
    ]);
    expect(JSON.stringify(roomsQueryOptions(session, cursor).queryKey)).not.toContain(token);
    expect(roomsQueryOptions(null, null).queryFn).toBe(skipToken);
    expect(roomBroadcastsQueryOptions(null, slug, null).queryFn).toBe(skipToken);
  });
});
