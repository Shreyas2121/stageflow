import type { BroadcastStatus, RoomSnapshot } from '@stageflow/shared';
import { useSessionStore } from '../../session/session-store';

export type AttendeePlayback =
  | { kind: 'waiting' }
  | { kind: 'live'; playlistUrl: string }
  | { kind: 'vod'; broadcastId: string; playlistUrl: string }
  | { kind: 'failed'; message: string }
  | { kind: 'pending'; status: BroadcastStatus; message: string | null };

export type ReplayPlayback =
  | { kind: 'vod'; playlistUrl: string }
  | { kind: 'unavailable'; status: BroadcastStatus; message: string | null };

const failedFallback = 'The broadcast failed.';

function trimmed(message: string | null): string | null {
  const text = message?.trim();
  return text ? text : null;
}

/** Attendees follow the live edge, then the finished playlist. Stage members never reach this. */
export function attendeePlayback(broadcast: RoomSnapshot['broadcast']): AttendeePlayback {
  if (!broadcast) return { kind: 'waiting' };
  if (broadcast.status === 'FAILED')
    return { kind: 'failed', message: trimmed(broadcast.errorMessage) ?? failedFallback };
  if ((broadcast.status === 'LIVE' || broadcast.status === 'STOPPING') && broadcast.playlistUrl)
    return { kind: 'live', playlistUrl: broadcast.playlistUrl };
  if (broadcast.status === 'READY' && broadcast.playlistUrl)
    return { kind: 'vod', broadcastId: broadcast.id, playlistUrl: broadcast.playlistUrl };
  return { kind: 'pending', status: broadcast.status, message: trimmed(broadcast.errorMessage) };
}

/** The replay route plays only a finished playlist. Every other status stays a status line. */
export function replayPlayback(broadcast: {
  status: BroadcastStatus;
  playlistUrl: string | null;
  errorMessage: string | null;
}): ReplayPlayback {
  if (broadcast.status === 'READY' && broadcast.playlistUrl)
    return { kind: 'vod', playlistUrl: broadcast.playlistUrl };
  return {
    kind: 'unavailable',
    status: broadcast.status,
    message: trimmed(broadcast.errorMessage),
  };
}

/**
 * Catalog playlist paths start with `/api`. `apiBase` already ends in `/api`, so join at the origin.
 */
export function broadcastMediaUrl(playlistUrl: string, apiBase: string): string {
  if (/^https?:\/\//i.test(playlistUrl)) return playlistUrl;
  return new URL(playlistUrl, new URL(apiBase).origin).href;
}

/**
 * Standard HLS, not low-latency HLS. Live manifest retries cover the first segment
 * inside the expected 8–20 second delay. `-1` starts at the live edge, or at the start of VOD.
 */
export function hlsPlayerConfig(token: string, mode: 'live' | 'vod') {
  return {
    lowLatencyMode: false as const,
    startPosition: -1,
    liveDurationInfinity: mode === 'live',
    ...(mode === 'live'
      ? {
          liveSyncMode: 'edge' as const,
          manifestLoadPolicy: {
            default: {
              maxTimeToFirstByteMs: 10_000,
              maxLoadTimeMs: 20_000,
              timeoutRetry: { maxNumRetry: 2, retryDelayMs: 0, maxRetryDelayMs: 0 },
              errorRetry: {
                maxNumRetry: 6,
                retryDelayMs: 1_000,
                maxRetryDelayMs: 4_000,
                backoff: 'exponential' as const,
              },
            },
          },
        }
      : {}),
    xhrSetup(xhr: XMLHttpRequest) {
      xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    },
    fetchSetup(context: { url: string }, initParams: RequestInit) {
      const headers = new Headers(initParams.headers);
      headers.set('Authorization', `Bearer ${token}`);
      return new Request(context.url, { ...initParams, headers });
    },
  };
}

export function noteMediaStatus(status: number | undefined, token: string): boolean {
  if (status !== 401) return false;
  useSessionStore.getState().clearSession(token);
  return true;
}
