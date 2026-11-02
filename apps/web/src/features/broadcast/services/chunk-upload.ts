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

/**
 * Uploads sequence 0 first and sends n+1 only after n returns 204.
 * Stopping drops every blob that has not been accepted, including the one in flight.
 */
export class ChunkUpload {
  private readonly queue: Blob[] = [];
  private nextSequence = 0;
  private sending = false;
  private stopped = false;
  private gaveUp = false;
  private abort: AbortController | null = null;

  constructor(
    private readonly broadcastId: string,
    private readonly token: string,
    private readonly send: ChunkSender,
    private readonly onGiveUp: () => void,
  ) {}

  push(blob: Blob): void {
    if (this.stopped) return;
    if (this.queue.length >= MAX_UNSENT_BLOBS) {
      this.giveUp();
      return;
    }
    this.queue.push(blob);
    void this.pump();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.queue.length = 0;
    this.abort?.abort();
  }

  private giveUp(): void {
    if (this.gaveUp) return;
    this.gaveUp = true;
    this.stop();
    // MediaRecorder forbids stop() inside dataavailable, which is what called push().
    queueMicrotask(() => this.onGiveUp());
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
    void this.pump();
  }
}
