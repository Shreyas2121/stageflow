import { useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';
import { apiUrl } from '../../../config/env';
import { bindBroadcastPlayback, PLAYBACK_FAILURE } from '../services/player-session';
import { broadcastMediaUrl, hlsPlayerConfig } from '../services/playback';

export type BroadcastPlayerProps = {
  playlistUrl: string;
  token: string;
  mode: 'live' | 'vod';
};

export function BroadcastPlayer({ playlistUrl, token, mode }: BroadcastPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const apiBase = apiUrl();
  const source = broadcastMediaUrl(playlistUrl, apiBase);
  const supported = Hls.isSupported();

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !supported || !source) return;
    const hls = new Hls(hlsPlayerConfig(token, mode, apiBase));
    return bindBroadcastPlayback({
      video,
      source,
      token,
      subscribeError(listener) {
        hls.on(Hls.Events.ERROR, (_event, data) => listener(data));
      },
      subscribeParsed(listener) {
        hls.on(Hls.Events.MANIFEST_PARSED, () => listener());
      },
      loadSource: (url) => hls.loadSource(url),
      attachMedia: () => hls.attachMedia(video),
      destroy: () => hls.destroy(),
      onError: setPlaybackError,
      onReady: () => setPlaybackError(null),
    });
  }, [apiBase, mode, source, supported, token]);

  if (!supported || !source) {
    return (
      <p
        className="mt-3 rounded-control border border-danger-line bg-danger-surface px-4.5 py-3.5 text-sm text-danger wrap-anywhere"
        role="alert"
      >
        {supported ? PLAYBACK_FAILURE : 'This browser cannot play the broadcast.'}
      </p>
    );
  }

  return (
    <div className="mt-3">
      <video
        ref={videoRef}
        className="aspect-video w-full rounded-lg bg-video"
        controls
        playsInline
        aria-label={mode === 'live' ? 'Live broadcast' : 'Broadcast replay'}
      />
      {playbackError && (
        <p
          className="mt-3 rounded-control border border-danger-line bg-danger-surface px-4.5 py-3.5 text-sm text-danger wrap-anywhere"
          role="alert"
        >
          {playbackError}
        </p>
      )}
    </div>
  );
}
