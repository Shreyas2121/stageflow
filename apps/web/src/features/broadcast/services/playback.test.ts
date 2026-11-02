import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RoomSnapshot } from '@stageflow/shared';
import { useSessionStore } from '../../session/session-store';
import {
  attendeePlayback,
  broadcastMediaUrl,
  hlsPlayerConfig,
  noteMediaStatus,
  replayPlayback,
} from './playback';

const playlist = '/api/broadcasts/broadcast-1/hls/index.m3u8';

function broadcast(
  status: NonNullable<RoomSnapshot['broadcast']>['status'],
  playlistUrl: string | null,
  errorMessage: string | null = null,
): NonNullable<RoomSnapshot['broadcast']> {
  return { id: 'broadcast-1', status, playlistUrl, errorMessage };
}

describe('attendee playback', () => {
  it('keeps the missing-broadcast state when the room has no row', () => {
    expect(attendeePlayback(null)).toEqual({ kind: 'waiting' });
  });

  it('plays the live edge for LIVE and STOPPING, and VOD once the playlist is finished', () => {
    expect(attendeePlayback(broadcast('LIVE', playlist))).toEqual({
      kind: 'live',
      playlistUrl: playlist,
    });
    expect(attendeePlayback(broadcast('STOPPING', playlist))).toEqual({
      kind: 'live',
      playlistUrl: playlist,
    });
    expect(attendeePlayback(broadcast('READY', playlist))).toEqual({
      kind: 'vod',
      broadcastId: 'broadcast-1',
      playlistUrl: playlist,
    });
  });

  it('shows a failure with no playlist, and waits without a player before a playlist exists', () => {
    expect(attendeePlayback(broadcast('FAILED', null, 'ffmpeg exited'))).toEqual({
      kind: 'failed',
      message: 'ffmpeg exited',
    });
    expect(attendeePlayback(broadcast('FAILED', playlist, '   '))).toEqual({
      kind: 'failed',
      message: 'The broadcast failed.',
    });
    expect(attendeePlayback(broadcast('STARTING', null))).toEqual({
      kind: 'pending',
      status: 'STARTING',
      message: null,
    });
    expect(attendeePlayback(broadcast('LIVE', null))).toEqual({
      kind: 'pending',
      status: 'LIVE',
      message: null,
    });
    expect(attendeePlayback(broadcast('READY', null))).toEqual({
      kind: 'pending',
      status: 'READY',
      message: null,
    });
  });
});

describe('replay playback', () => {
  it('plays only a finished playlist and keeps every other status off the player', () => {
    expect(replayPlayback(broadcast('READY', playlist))).toEqual({
      kind: 'vod',
      playlistUrl: playlist,
    });
    for (const status of ['STARTING', 'LIVE', 'STOPPING', 'FAILED'] as const) {
      expect(replayPlayback(broadcast(status, playlist, 'still open'))).toEqual({
        kind: 'unavailable',
        status,
        message: 'still open',
      });
    }
    expect(replayPlayback(broadcast('READY', null))).toEqual({
      kind: 'unavailable',
      status: 'READY',
      message: null,
    });
  });
});

describe('playlist requests', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('joins a catalog path at the API origin and leaves an absolute URL unchanged', () => {
    expect(broadcastMediaUrl(playlist, 'http://127.0.0.1:3000/api')).toBe(
      'http://127.0.0.1:3000/api/broadcasts/broadcast-1/hls/index.m3u8',
    );
    expect(broadcastMediaUrl('https://cdn.example/live.m3u8', 'http://127.0.0.1:3000/api')).toBe(
      'https://cdn.example/live.m3u8',
    );
  });

  it('attaches the guest bearer token and stays on standard live HLS', () => {
    const live = hlsPlayerConfig('guest-token', 'live');
    const vod = hlsPlayerConfig('guest-token', 'vod');
    expect(live.lowLatencyMode).toBe(false);
    expect(vod.lowLatencyMode).toBe(false);
    expect(live.startPosition).toBe(-1);
    expect(live.liveSyncMode).toBe('edge');
    expect(live.liveDurationInfinity).toBe(true);
    expect(vod.liveDurationInfinity).toBe(false);
    expect(vod.liveSyncMode).toBeUndefined();
    const retry = live.manifestLoadPolicy?.default.errorRetry;
    expect(retry?.maxNumRetry).toBe(6);
    expect((retry?.maxNumRetry ?? 0) * (retry?.retryDelayMs ?? 0)).toBeGreaterThanOrEqual(6_000);

    const headers: Record<string, string> = {};
    live.xhrSetup?.({
      setRequestHeader: (name: string, value: string) => {
        headers[name] = value;
      },
    } as XMLHttpRequest);
    expect(headers.Authorization).toBe('Bearer guest-token');

    const request = live.fetchSetup?.(
      { url: 'http://127.0.0.1:3000/api/broadcasts/broadcast-1/hls/segment.ts' } as never,
      { method: 'GET' },
    );
    expect(request).toBeInstanceOf(Request);
    if (request instanceof Request)
      expect(request.headers.get('Authorization')).toBe('Bearer guest-token');
  });

  it('clears the guest session when a playlist or segment returns 401', () => {
    const previous = useSessionStore.getState().clearSession;
    const clearSession = vi.fn();
    useSessionStore.setState({ clearSession });
    expect(noteMediaStatus(204, 'guest-token')).toBe(false);
    expect(noteMediaStatus(undefined, 'guest-token')).toBe(false);
    expect(clearSession).not.toHaveBeenCalled();
    expect(noteMediaStatus(401, 'guest-token')).toBe(true);
    expect(clearSession).toHaveBeenCalledExactlyOnceWith('guest-token');
    useSessionStore.setState({ clearSession: previous });
  });
});
