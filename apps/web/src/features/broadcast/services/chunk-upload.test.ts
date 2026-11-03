import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ChunkUpload,
  postChunk,
  MAX_UNSENT_BYTES,
  CHUNK_REQUEST_TIMEOUT_MS,
  type ChunkRequest,
} from './chunk-upload';
import { useSessionStore } from '../../session/session-store';

const broadcastId = 'broadcast-1';
const token = 'guest-token';

function blob(label: string): Blob {
  return new Blob([label]);
}

describe('ChunkUpload', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('sends sequence 0 first and waits for 204 before the next blob', async () => {
    const sent: number[] = [];
    const first = blob('header');
    const second = blob('next');
    let release: (status: number) => void = () => undefined;
    const upload = new ChunkUpload(
      broadcastId,
      token,
      (request) => {
        sent.push(request.sequence);
        expect(request.body).toBe(request.sequence === 0 ? first : second);
        if (request.sequence === 0)
          return new Promise<number>((resolve) => {
            release = resolve;
          });
        return Promise.resolve(204);
      },
      () => undefined,
    );
    upload.push(first);
    upload.push(second);
    await Promise.resolve();
    expect(sent).toEqual([0]);
    release(204);
    await vi.waitFor(() => expect(sent).toEqual([0, 1]));
  });

  it('stops local upload on the ninth unsent blob and does not send it', async () => {
    const sent: number[] = [];
    const onGiveUp = vi.fn();
    let release: (status: number) => void = () => undefined;
    const upload = new ChunkUpload(
      broadcastId,
      token,
      (request) => {
        sent.push(request.sequence);
        return new Promise<number>((resolve) => {
          release = resolve;
        });
      },
      onGiveUp,
    );
    for (let index = 0; index < 8; index += 1) upload.push(blob(String(index)));
    await Promise.resolve();
    expect(sent).toEqual([0]);
    expect(onGiveUp).not.toHaveBeenCalled();
    upload.push(blob('ninth'));
    await vi.waitFor(() => expect(onGiveUp).toHaveBeenCalledOnce());
    release(204);
    await Promise.resolve();
    expect(sent).toEqual([0]);
  });

  it('drops an unsent blob when upload is stopped', async () => {
    const sent: ChunkRequest[] = [];
    let release: (status: number) => void = () => undefined;
    const upload = new ChunkUpload(
      broadcastId,
      token,
      (request) => {
        sent.push(request);
        return new Promise<number>((resolve) => {
          release = resolve;
        });
      },
      () => undefined,
    );
    upload.push(blob('header'));
    upload.push(blob('queued'));
    await Promise.resolve();
    expect(sent.map((request) => request.sequence)).toEqual([0]);
    upload.stop();
    expect(sent[0]?.signal.aborted).toBe(true);
    release(204);
    await Promise.resolve();
    expect(sent).toHaveLength(1);
  });

  it('counts in-flight bytes, accepts the exact budget, and aborts on one byte more', async () => {
    const sent: ChunkRequest[] = [];
    const onGiveUp = vi.fn();
    const upload = new ChunkUpload(
      broadcastId,
      token,
      (request) => {
        sent.push(request);
        return new Promise<number>(() => undefined);
      },
      onGiveUp,
    );
    const large = new Blob([new Uint8Array(MAX_UNSENT_BYTES / 4)]);
    for (let i = 0; i < 4; i += 1) upload.push(large);
    expect(onGiveUp).not.toHaveBeenCalled();
    expect(sent).toHaveLength(1);
    upload.push(blob('x'));
    await Promise.resolve();
    expect(onGiveUp).toHaveBeenCalledOnce();
    expect(sent[0]?.signal.aborted).toBe(true);
    await expect(upload.drain(8_000)).resolves.toEqual({ ok: false, reason: 'upload' });
    upload.stop();
    expect(onGiveUp).toHaveBeenCalledOnce();
  });

  it('returns accepted bytes to the budget and drains subsequent full-size chunks', async () => {
    const send = vi.fn(() => Promise.resolve(204));
    const onGiveUp = vi.fn();
    const upload = new ChunkUpload(broadcastId, token, send, onGiveUp);
    const large = new Blob([new Uint8Array(MAX_UNSENT_BYTES / 4)]);
    for (let round = 0; round < 3; round += 1) {
      for (let i = 0; i < 4; i += 1) upload.push(large);
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes((round + 1) * 4));
    }
    await expect(upload.drain(8_000)).resolves.toEqual({ ok: true });
    expect(onGiveUp).not.toHaveBeenCalled();
  });

  it('bounds a stalled live request, ignores late success, and preserves failure for drain', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let release!: (status: number) => void;
      const sent: ChunkRequest[] = [];
      const onGiveUp = vi.fn();
      const upload = new ChunkUpload(
        broadcastId,
        token,
        (request) => {
          sent.push(request);
          return new Promise<number>((resolve) => {
            release = resolve;
          });
        },
        onGiveUp,
      );
      upload.push(blob('header'));
      upload.push(blob('queued'));
      await vi.advanceTimersByTimeAsync(CHUNK_REQUEST_TIMEOUT_MS - 1);
      expect(sent[0]?.signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(sent[0]?.signal.aborted).toBe(true);
      expect(onGiveUp).toHaveBeenCalledOnce();
      release(204);
      await Promise.resolve();
      upload.push(blob('late'));
      expect(sent).toHaveLength(1);
      await expect(upload.drain(8_000)).resolves.toEqual({ ok: false, reason: 'upload' });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not send the next sequence when the response is not 204', async () => {
    const sent: number[] = [];
    const onGiveUp = vi.fn();
    const upload = new ChunkUpload(
      broadcastId,
      token,
      (request) => {
        sent.push(request.sequence);
        return Promise.resolve(409);
      },
      onGiveUp,
    );
    upload.push(blob('header'));
    upload.push(blob('next'));
    await vi.waitFor(() => expect(onGiveUp).toHaveBeenCalledOnce());
    expect(sent).toEqual([0]);
  });

  it('posts the raw chunk with the guest token and the sequence header', async () => {
    vi.stubEnv('VITE_API_BASE_URL', 'http://localhost:4000/api');
    const previous = useSessionStore.getState().clearSession;
    const clearSession = vi.fn();
    useSessionStore.setState({ clearSession });
    const fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    const body = blob('header');
    await expect(
      postChunk({ broadcastId, token, sequence: 0, body, signal: controller.signal }),
    ).resolves.toBe(204);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      'http://localhost:4000/api/broadcasts/broadcast-1/chunks',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer guest-token',
          'Content-Type': 'application/octet-stream',
          'x-chunk-sequence': '0',
        },
        body,
        signal: controller.signal,
      },
    );
    expect(clearSession).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }));
    await expect(
      postChunk({ broadcastId, token, sequence: 1, body, signal: controller.signal }),
    ).resolves.toBe(401);
    expect(clearSession).toHaveBeenCalledExactlyOnceWith(token);
    useSessionStore.setState({ clearSession: previous });
  });

  it('drains the pending blob and the sealed queue before resolving', async () => {
    const sent: Blob[] = [];
    let release: (status: number) => void = () => undefined;
    const upload = new ChunkUpload(
      broadcastId,
      token,
      (request) => {
        sent.push(request.body);
        return new Promise<number>((resolve) => {
          release = resolve;
        });
      },
      () => undefined,
    );
    const header = blob('header');
    const queued = blob('queued');
    const late = blob('late');
    upload.push(header);
    upload.push(queued);
    await Promise.resolve();
    const drained = upload.drain(8_000);
    upload.push(late);
    expect(sent).toEqual([header]);
    release(204);
    await vi.waitFor(() => expect(sent).toEqual([header, queued]));
    release(204);
    await expect(drained).resolves.toEqual({ ok: true });
    expect(sent).toEqual([header, queued]);
  });

  it('aborts a drain that exceeds its bound and does not keep the request open', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let signal: AbortSignal | undefined;
      const onGiveUp = vi.fn();
      const upload = new ChunkUpload(
        broadcastId,
        token,
        (request) => {
          signal = request.signal;
          return new Promise<number>(() => undefined);
        },
        onGiveUp,
      );
      upload.push(blob('header'));
      upload.push(blob('queued'));
      await Promise.resolve();
      const drained = upload.drain(1_000);
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(drained).resolves.toEqual({ ok: false, reason: 'timeout' });
      expect(signal?.aborted).toBe(true);
      expect(onGiveUp).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('resolves an in-flight drain as aborted when upload is stopped', async () => {
    const upload = new ChunkUpload(
      broadcastId,
      token,
      () => new Promise<number>(() => undefined),
      () => undefined,
    );
    upload.push(blob('header'));
    await Promise.resolve();
    const drained = upload.drain(8_000);
    upload.stop();
    await expect(drained).resolves.toEqual({ ok: false, reason: 'aborted' });
  });

  it('reports a refused chunk as an upload failure while a drain is waiting', async () => {
    const upload = new ChunkUpload(
      broadcastId,
      token,
      () => Promise.resolve(409),
      () => undefined,
    );
    upload.push(blob('header'));
    const drained = upload.drain(8_000);
    await expect(drained).resolves.toEqual({ ok: false, reason: 'upload' });
  });
});
