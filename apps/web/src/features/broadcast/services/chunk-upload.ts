import { apiUrl } from '../../../config/env';
import { useSessionStore } from '../../session/session-store';

/** Unsent blobs include the one currently waiting for 204. The ninth is refused. */
export const MAX_UNSENT_BLOBS = 8;

export type ChunkRequest = {
  broadcastId: string;
  token: string;
  sequence: number;
  body: Blob;
  signal: AbortSignal;
};

export type ChunkSender = (request: ChunkRequest) => Promise<number>;

export async function postChunk(request: ChunkRequest): Promise<number> {
  const response = await fetch(
    `${apiUrl()}/broadcasts/${encodeURIComponent(request.broadcastId)}/chunks`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${request.token}`,
        'Content-Type': 'application/octet-stream',
        'x-chunk-sequence': String(request.sequence),
      },
      body: request.body,
      signal: request.signal,
    },
  );
  if (response.status === 401) useSessionStore.getState().clearSession(request.token);
  return response.status;
}

export type ChunkDrain = { ok: true } | { ok: false; reason: 'timeout' | 'upload' | 'aborted' };

/**
 * Uploads sequence 0 first and sends n+1 only after n returns 204.
 * stop() drops every blob that has not been accepted, including the one in flight.
 * drain() accepts no further blobs and waits until the queued ones are accepted.
 */
export class ChunkUpload {
  private readonly queue: Blob[] = [];
  private nextSequence = 0;
  private sending = false;
  private stopped = false;
  private sealed = false;
  private gaveUp = false;
  private abort: AbortController | null = null;
  private drainPromise: Promise<ChunkDrain> | null = null;
  private resolveDrain: ((result: ChunkDrain) => void) | null = null;
  private drainTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly broadcastId: string,
    private readonly token: string,
    private readonly send: ChunkSender,
    private readonly onGiveUp: () => void,
  ) {}

  push(blob: Blob): void {
    if (this.stopped || this.sealed) return;
    if (this.queue.length >= MAX_UNSENT_BLOBS) {
      this.giveUp();
      return;
    }
    this.queue.push(blob);
    void this.pump();
  }

  /** Ignores later blobs. Blobs already queued, including the one in flight, stay. */
  seal(): void {
    this.sealed = true;
  }

  drain(timeoutMs: number): Promise<ChunkDrain> {
    if (this.drainPromise) return this.drainPromise;
    this.sealed = true;
    this.drainPromise = new Promise((resolve) => {
      this.resolveDrain = resolve;
    });
    if (this.stopped) {
      this.settle({ ok: false, reason: 'aborted' });
      return this.drainPromise;
    }
    void this.pump();
    if (!this.sending && this.queue.length === 0) this.settle({ ok: true });
    else this.drainTimer = setTimeout(() => this.expire(), timeoutMs);
    return this.drainPromise;
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.sealed = true;
    this.queue.length = 0;
    this.abort?.abort();
    this.settle({ ok: false, reason: 'aborted' });
  }

  private expire(): void {
    if (this.resolveDrain === null) return;
    this.stopped = true;
    this.sealed = true;
    this.queue.length = 0;
    this.abort?.abort();
    this.settle({ ok: false, reason: 'timeout' });
  }

  private giveUp(): void {
    if (this.gaveUp) return;
    this.gaveUp = true;
    if (!this.stopped) {
      this.stopped = true;
      this.sealed = true;
      this.queue.length = 0;
      this.abort?.abort();
    }
    this.settle({ ok: false, reason: 'upload' });
    // MediaRecorder forbids stop() inside dataavailable, which is what called push().
    queueMicrotask(() => this.onGiveUp());
  }

  private settle(result: ChunkDrain): void {
    if (this.drainTimer !== null) clearTimeout(this.drainTimer);
    this.drainTimer = null;
    const resolve = this.resolveDrain;
    this.resolveDrain = null;
    resolve?.(result);
  }

  private async pump(): Promise<void> {
    if (this.sending || this.stopped) return;
    const blob = this.queue[0];
    if (!blob) return;
    this.sending = true;
    const sequence = this.nextSequence;
    const abort = new AbortController();
    this.abort = abort;
    let status: number;
    try {
      status = await this.send({
        broadcastId: this.broadcastId,
        token: this.token,
        sequence,
        body: blob,
        signal: abort.signal,
      });
    } catch {
      this.sending = false;
      if (!this.stopped) this.giveUp();
      return;
    }
    this.sending = false;
    if (this.stopped) return;
    if (status !== 204) {
      this.giveUp();
      return;
    }
    this.queue.shift();
    this.nextSequence += 1;
    this.abort = null;
    if (this.sealed && this.queue.length === 0) {
      this.settle({ ok: true });
      return;
    }
    void this.pump();
  }
}
