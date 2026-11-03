import type { BroadcastStatus } from '@stageflow/shared';
import type { BroadcastRecorder, RecorderFinish, StageSource } from './stage-recorder';

export const RECORDER_START_FAILURE =
  'The broadcast recorder could not start. Room media is still available.';
export const PRODUCER_FAILURE = 'The broadcast producer failed. Room media is still available.';

export type BroadcastSessionHost = {
  readonly token: string;
  createRecorder(options: {
    broadcastId: string;
    token: string;
    onCap: () => void;
  }): BroadcastRecorder;
  /** Must not throw. The room drops a rejected server stop. */
  stopBroadcast(): void;
  onError(message: string): void;
};

export type BroadcastSyncInput = {
  joined: boolean;
  broadcast: { id: string; status: BroadcastStatus } | null;
  sources: () => readonly StageSource[];
};

/** Null when the recording finished or was aborted. Otherwise the room error to show. */
export function recordingFinishError(result: RecorderFinish): string | null {
  if (result.ok || result.reason === 'aborted') return null;
  if (result.reason === 'recorder')
    return 'The broadcast recorder failed before recording finished.';
  if (result.reason === 'timeout')
    return 'The broadcast stopped before the last of the recording uploaded.';
  return 'The broadcast stopped before every recorded chunk was accepted.';
}

/** Owns one recording. The room supplies stage sources and the server stop. */
export class BroadcastSession {
  private recorder: BroadcastRecorder | null = null;
  private recordingId: string | null = null;
  private armed = false;

  constructor(private readonly host: BroadcastSessionHost) {}

  /** Armed, or holding a recorder. Catalog status stays with the room. */
  get active(): boolean {
    return this.armed || this.recorder !== null;
  }

  arm(): void {
    this.armed = true;
  }

  /** Chunks are accepted only while the broadcast is LIVE, which the start ack already waited for. */
  sync(input: BroadcastSyncInput): void {
    const { joined, broadcast, sources } = input;
    if (this.recorder) {
      const live = joined && broadcast?.id === this.recordingId && broadcast.status === 'LIVE';
      if (!live) {
        this.abort();
        return;
      }
      this.recorder.update(sources());
      return;
    }
    if (!this.armed || !joined || broadcast?.status !== 'LIVE') return;
    this.armed = false;
    this.recordingId = broadcast.id;
    try {
      const recorder = this.host.createRecorder({
        broadcastId: broadcast.id,
        token: this.host.token,
        onCap: () => {
          if (this.recorder === recorder) this.onCap();
        },
      });
      this.recorder = recorder;
      recorder.start();
      recorder.update(sources());
    } catch {
      this.recorder?.stop();
      this.recorder = null;
      this.recordingId = null;
      this.host.stopBroadcast();
      this.host.onError(RECORDER_START_FAILURE);
    }
  }

  /** Uploads the final blob before the caller sends broadcast:stop. */
  finish(): Promise<RecorderFinish> {
    this.armed = false;
    const recorder = this.recorder;
    if (!recorder) return Promise.resolve({ ok: true });
    return recorder.finish().finally(() => {
      if (this.recorder === recorder) {
        this.recorder = null;
        this.recordingId = null;
      }
    });
  }

  abort(): void {
    this.armed = false;
    const recorder = this.recorder;
    this.recorder = null;
    this.recordingId = null;
    recorder?.stop();
  }

  private onCap(): void {
    this.abort();
    this.host.onError(PRODUCER_FAILURE);
    this.host.stopBroadcast();
  }
}
