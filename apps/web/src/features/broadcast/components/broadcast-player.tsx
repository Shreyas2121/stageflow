import { useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';
import { apiUrl } from '../../../config/env';
import { broadcastMediaUrl, hlsPlayerConfig, noteMediaStatus } from '../services/playback';

export function BroadcastPlayer({
  playlistUrl,
  token,
  mode,
}: {
  playlistUrl: string;
  token: string;
  mode: 'live' | 'vod';
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const apiBase = apiUrl();
  const source = broadcastMediaUrl(playlistUrl, apiBase);
  const supported = Hls.isSupported();

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !supported || !source) return;
    const hls = new Hls(hlsPlayerConfig(token, mode, apiBase));
    let active = true;
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      hls.destroy();
    };
    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (!active) return;
      if (noteMediaStatus(data.response?.code, token)) {
        close();
        return;
      }
      if (!data.fatal) return;
      setPlaybackError('The broadcast could not be played.');
      close();
    });
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      if (!active) return;
      setPlaybackError(null);
      void video.play().catch(() => undefined);
    });
    hls.loadSource(source);
    hls.attachMedia(video);
    return () => {
      active = false;
      close();
    };
  }, [apiBase, mode, source, supported, token]);

  if (!supported || !source) {
    return (
      <p
        className="mt-3 rounded-control border border-danger-line bg-danger-surface px-4.5 py-3.5 text-sm text-danger wrap-anywhere"
        role="alert"
      >
        {supported
          ? 'The broadcast could not be played.'
          : 'This browser cannot play the broadcast.'}
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
