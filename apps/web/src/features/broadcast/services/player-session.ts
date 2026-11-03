import { noteMediaStatus } from './playback';

export const PLAYBACK_FAILURE = 'The broadcast could not be played.';

export type PlaybackErrorData = {
  fatal: boolean;
  response?: { code?: number };
};

type PlaybackVideo = { play(): Promise<void> };

/**
 * Attaches one HLS instance and releases it once. A 401 clears the guest session
 * through the shared media-status path and does not surface as a playback error.
 */
export function bindBroadcastPlayback(input: {
  video: PlaybackVideo;
  source: string;
  token: string;
  subscribeError(listener: (data: PlaybackErrorData) => void): void;
  subscribeParsed(listener: () => void): void;
  loadSource(source: string): void;
  attachMedia(video: PlaybackVideo): void;
  destroy(): void;
  onError(message: string): void;
  onReady(): void;
}): () => void {
  let active = true;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    input.destroy();
  };
  input.subscribeError((data) => {
    if (!active || closed) return;
    if (noteMediaStatus(data.response?.code, input.token)) {
      close();
      return;
    }
    if (!data.fatal) return;
    input.onError(PLAYBACK_FAILURE);
    close();
  });
  input.subscribeParsed(() => {
    if (!active || closed) return;
    input.onReady();
    void input.video.play().catch(() => undefined);
  });
  input.loadSource(input.source);
  input.attachMedia(input.video);
  return () => {
    active = false;
    close();
  };
}
