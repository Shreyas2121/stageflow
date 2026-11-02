import { afterEach, describe, expect, it, vi } from 'vitest';
import { getBroadcast, parseBroadcast } from './api';
import { useSessionStore } from '../session/session-store';

const id = '11111111-1111-4111-8111-111111111111';
const roomId = '22222222-2222-4222-8222-222222222222';

function catalog(overrides: Record<string, unknown> = {}) {
  return {
    id,
    roomId,
    status: 'READY',
    playlistPath: `broadcasts/${id}/index.m3u8`,
    playlistUrl: `/api/broadcasts/${id}/hls/index.m3u8`,
    thumbnailPath: null,
    errorMessage: null,
    startedAt: '2026-11-02T00:00:00.000Z',
    endedAt: '2026-11-02T00:01:00.000Z',
    createdAt: '2026-11-02T00:00:00.000Z',
    ...overrides,
  };
}

describe('broadcast catalog', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('keeps the playlist URL and drops the server file path', () => {
    expect(parseBroadcast(catalog())).toMatchObject({
      id,
      status: 'READY',
      playlistUrl: `/api/broadcasts/${id}/hls/index.m3u8`,
      errorMessage: null,
    });
    expect(parseBroadcast(catalog())).not.toHaveProperty('playlistPath');
  });

  it('rejects a catalog that cannot identify a playlist', () => {
    expect(() => parseBroadcast(catalog({ playlistUrl: 'not a path' }))).toThrow(
      'Invalid broadcast',
    );
    expect(() => parseBroadcast(catalog({ status: 'DONE' }))).toThrow('Invalid broadcast');
  });

  it('loads one broadcast with the guest token and clears the session on 401', async () => {
    vi.stubEnv('VITE_API_BASE_URL', 'http://localhost:4000/api');
    const previous = useSessionStore.getState().clearSession;
    const clearSession = vi.fn();
    useSessionStore.setState({ clearSession });
    const fetchMock = vi.fn(() => Promise.resolve(Response.json(catalog())));
    vi.stubGlobal('fetch', fetchMock);
    await expect(getBroadcast(id, 'guest-token')).resolves.toMatchObject({ id, status: 'READY' });
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      `http://localhost:4000/api/broadcasts/${id}`,
      expect.objectContaining({
        headers: { Authorization: 'Bearer guest-token' },
      }),
    );
    fetchMock.mockResolvedValueOnce(Response.json({ message: 'Sign in again.' }, { status: 401 }));
    await expect(getBroadcast(id, 'guest-token')).rejects.toMatchObject({ status: 401 });
    expect(clearSession).toHaveBeenCalledExactlyOnceWith('guest-token');
    useSessionStore.setState({ clearSession: previous });
  });
});
