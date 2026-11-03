import { afterEach, describe, expect, it, vi } from 'vitest';
import { useSessionStore } from '../../session/session-store';
import { bindBroadcastPlayback, PLAYBACK_FAILURE, type PlaybackErrorData } from './player-session';

const source = '/api/broadcasts/broadcast-1/hls/index.m3u8';

function library() {
  const errorListeners: ((data: PlaybackErrorData) => void)[] = [];
  const parsedListeners: (() => void)[] = [];
  return {
    destroy: vi.fn(),
    loadSource: vi.fn(),
    attachMedia: vi.fn(),
    subscribeError(listener: (data: PlaybackErrorData) => void) {
      errorListeners.push(listener);
    },
    subscribeParsed(listener: () => void) {
      parsedListeners.push(listener);
    },
    emitError(data: PlaybackErrorData) {
      for (const listener of [...errorListeners]) listener(data);
    },
    emitParsed() {
      for (const listener of [...parsedListeners]) listener();
    },
  };
}

function bind(media = library(), play: () => Promise<void> = () => Promise.resolve()) {
  const onError = vi.fn();
  const onReady = vi.fn();
  const stop = bindBroadcastPlayback({
    video: { play },
    source,
    token: 'guest-token',
    subscribeError: media.subscribeError,
    subscribeParsed: media.subscribeParsed,
    loadSource: media.loadSource,
    attachMedia: media.attachMedia,
    destroy: media.destroy,
    onError,
    onReady,
  });
  return { media, onError, onReady, stop, play };
}

describe('broadcast playback session', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('loads the playlist and attaches media without releasing the player', () => {
    const { media } = bind();
    expect(media.loadSource).toHaveBeenCalledExactlyOnceWith(source);
    expect(media.attachMedia).toHaveBeenCalledOnce();
    expect(media.destroy).not.toHaveBeenCalled();
  });

  it('ignores a non-fatal error', () => {
    const { media, onError } = bind();
    media.emitError({ fatal: false, response: { code: 404 } });
    expect(onError).not.toHaveBeenCalled();
    expect(media.destroy).not.toHaveBeenCalled();
  });

  it('reports a fatal error and destroys the player once', () => {
    const { media, onError, onReady, stop } = bind();
    media.emitError({ fatal: true });
    media.emitError({ fatal: true });
    media.emitParsed();
    stop();
    expect(onError).toHaveBeenCalledExactlyOnceWith(PLAYBACK_FAILURE);
    expect(onReady).not.toHaveBeenCalled();
    expect(media.destroy).toHaveBeenCalledOnce();
  });

  it('clears the guest session on 401 and does not report a playback error', () => {
    const previous = useSessionStore.getState().clearSession;
    const clearSession = vi.fn();
    useSessionStore.setState({ clearSession });
    const { media, onError, stop } = bind();
    media.emitError({ fatal: true, response: { code: 401 } });
    stop();
    expect(clearSession).toHaveBeenCalledExactlyOnceWith('guest-token');
    expect(onError).not.toHaveBeenCalled();
    expect(media.destroy).toHaveBeenCalledOnce();
    useSessionStore.setState({ clearSession: previous });
  });

  it('starts playback when the manifest parses and ignores a rejected play()', async () => {
    const play = vi.fn(() => Promise.reject(new Error('autoplay blocked')));
    const { media, onError, onReady } = bind(library(), play);
    media.emitParsed();
    await expect(play.mock.results[0]?.value).rejects.toThrow('autoplay blocked');
    expect(onReady).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
    expect(media.destroy).not.toHaveBeenCalled();
  });

  it('ignores later events after close', () => {
    const { media, onError, onReady, stop } = bind();
    stop();
    stop();
    media.emitError({ fatal: true });
    media.emitParsed();
    expect(onError).not.toHaveBeenCalled();
    expect(onReady).not.toHaveBeenCalled();
    expect(media.destroy).toHaveBeenCalledOnce();
  });
});
