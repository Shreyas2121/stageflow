import { encodeHistoryCursor } from '@stageflow/shared';
import { skipToken } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useSessionStore } from '../session/session-store';
import {
  parseRoom,
  deleteBroadcast,
  setBroadcastVisibility,
  listBroadcasts,
  listRooms,
  listReplayDeletions,
  retryReplayDeletion,
} from './api';
import {
  roomBroadcastsQueryOptions,
  roomsQueryOptions,
  replayDeletionsQueryOptions,
} from './query-options';

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
    scheduledStartAt: null,
    requireAdmission: false,
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
    visibility: 'LINK',
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
    expect(roomsQueryOptions(session).queryKey).toEqual(['private', userId, 'rooms']);
    expect(roomBroadcastsQueryOptions(session, slug).queryKey).toEqual([
      'private',
      userId,
      'room-broadcasts',
      slug,
    ]);
    expect(JSON.stringify(roomsQueryOptions(session).queryKey)).not.toContain(token);
    expect(roomsQueryOptions(null).queryFn).toBe(skipToken);
    expect(roomBroadcastsQueryOptions(null, slug).queryFn).toBe(skipToken);
    expect(replayDeletionsQueryOptions(session, slug).queryKey).toEqual([
      'private',
      userId,
      'replay-deletions',
      slug,
    ]);
    expect(replayDeletionsQueryOptions(null, slug).queryFn).toBe(skipToken);
  });

  it('pages deletion inventory with cancellation and validates its narrow response', async () => {
    vi.stubEnv('VITE_API_BASE_URL', 'http://localhost:4000/api');
    const item = { id: broadcastId, roomId: broadcast().roomId, createdAt: broadcast().createdAt };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ items: [item], nextCursor: cursor }))
      .mockResolvedValueOnce(Response.json({ items: [], nextCursor: null }));
    vi.stubGlobal('fetch', fetchMock);
    const signal = new AbortController().signal;
    await expect(listReplayDeletions(slug, token, null, signal)).resolves.toEqual({
      items: [item],
      nextCursor: cursor,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `http://localhost:4000/api/rooms/${slug}/broadcast-deletions`,
      expect.objectContaining({
        headers: { Authorization: `Bearer ${token}` },
        signal: expect.any(AbortSignal),
      }),
    );
    await listReplayDeletions(slug, token, cursor);
    expect(new URL(String(fetchMock.mock.calls[1]?.[0])).searchParams.get('cursor')).toBe(cursor);
    for (const body of [
      { items: [{ ...item, id: 'bad' }], nextCursor: null },
      { items: [], nextCursor: 'bad' },
      [],
    ]) {
      fetchMock.mockResolvedValueOnce(Response.json(body));
      await expect(listReplayDeletions(slug, token, null)).rejects.toMatchObject({
        code: 'invalid_response',
      });
    }
  });

  it('retries only persisted deletion intent and preserves retry failures', async () => {
    vi.stubEnv('VITE_API_BASE_URL', 'http://localhost:4000/api');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(
        Response.json({ error: 'broadcast_delete_failed', message: 'Try again.' }, { status: 500 }),
      );
    vi.stubGlobal('fetch', fetchMock);
    await expect(retryReplayDeletion(broadcastId, token)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      `http://localhost:4000/api/broadcasts/${broadcastId}/deletion-retry`,
      expect.objectContaining({ method: 'POST', headers: { Authorization: `Bearer ${token}` } }),
    );
    await expect(retryReplayDeletion(broadcastId, token)).rejects.toMatchObject({
      code: 'broadcast_delete_failed',
      message: 'Try again.',
    });
  });
});

it('posts only visibility and validates the returned catalog', async () => {
  vi.stubEnv('VITE_API_BASE_URL', 'http://localhost:4000/api');
  const response = { ...broadcast(), visibility: 'HOST' };
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(Response.json(response))
    .mockResolvedValueOnce(Response.json({ ...response, visibility: 'host' }));
  vi.stubGlobal('fetch', fetchMock);
  try {
    await expect(setBroadcastVisibility(broadcastId, 'HOST', token)).resolves.toEqual(response);
    expect(fetchMock).toHaveBeenCalledWith(
      `http://localhost:4000/api/broadcasts/${broadcastId}/visibility`,
      expect.objectContaining({
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ visibility: 'HOST' }),
      }),
    );
    await expect(setBroadcastVisibility(broadcastId, 'HOST', token)).rejects.toMatchObject({
      code: 'invalid_response',
    });
  } finally {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  }
});

it('accepts an empty 204 delete and preserves mutation failure messages and token-match cleanup', async () => {
  vi.stubEnv('VITE_API_BASE_URL', 'http://localhost:4000/api');
  useSessionStore.setState({ session: { token, userId, displayName: 'Ava' } });
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(new Response(null, { status: 204 }))
    .mockResolvedValueOnce(
      Response.json(
        {
          error: 'broadcast_delete_failed',
          message: 'The replay could not be deleted. Try again.',
        },
        { status: 500 },
      ),
    )
    .mockResolvedValueOnce(
      Response.json({ error: 'unauthorized', message: 'Sign in again.' }, { status: 401 }),
    );
  vi.stubGlobal('fetch', fetchMock);
  try {
    await expect(deleteBroadcast(broadcastId, token)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      `http://localhost:4000/api/broadcasts/${broadcastId}`,
      expect.objectContaining({ method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }),
    );
    await expect(deleteBroadcast(broadcastId, token)).rejects.toMatchObject({
      code: 'broadcast_delete_failed',
      message: 'The replay could not be deleted. Try again.',
    });
    expect(useSessionStore.getState().session?.token).toBe(token);
    await expect(deleteBroadcast(broadcastId, token)).rejects.toMatchObject({ status: 401 });
    expect(useSessionStore.getState().session).toBeNull();
  } finally {
    useSessionStore.setState({ session: null });
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  }
});

it('parses scheduled catalog fields, including a past instant', () => {
  const scheduled = {
    ...room(),
    status: 'SCHEDULED',
    scheduledStartAt: '2000-01-01T00:00:00.000Z',
    requireAdmission: true,
  };
  expect(parseRoom(scheduled)).toEqual(scheduled);
  expect(parseRoom(room())).toEqual(room());
});
it.each([
  { scheduledStartAt: undefined },
  { scheduledStartAt: '2026-02-30T00:00:00.000Z' },
  { scheduledStartAt: '2026-11-05T12:00:00Z' },
  { requireAdmission: undefined },
  { requireAdmission: 'false' },
  { status: 'UNKNOWN' },
])('rejects invalid schedule response fields: %j', (fields) => {
  expect(() => parseRoom({ ...room(), ...fields })).toThrow('Invalid room');
});
