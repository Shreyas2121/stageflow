import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChunkUpload, postChunk, type ChunkRequest } from './chunk-upload';
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
});
