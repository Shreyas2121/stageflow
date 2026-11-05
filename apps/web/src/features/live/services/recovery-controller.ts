import { RECONNECT_GRACE_MS, type CommandAck, type ResumeAck } from '@stageflow/shared';
import type { RoomConnection } from './signaling';

type Resumed = Extract<ResumeAck, { ok: true }>;
type ResumeIdentity = { participantId: string; resumeCredential: string };

export type RecoveryHost = {
  readonly connection: RoomConnection | null;
  canRecover(): boolean;
  hasJoined(): boolean;
  setConnection(connection: RoomConnection | null): void;
  open(onResumed: (result: Resumed) => void): RoomConnection;
  resumed(connection: RoomConnection, result: Resumed): void;
  retrying(message: string): void;
  failed(message: string): void;
  ended(): void;
};

/** Answers that can succeed on a later selected attempt, including a generation loser. */
function retryableResumeMessage(error: string): string | null {
  switch (error) {
    case 'server_busy':
      return 'The live server is busy. Try again shortly.';
    case 'server_error':
      return 'Unable to update the live room. Join again.';
    case 'rate_limited':
      return 'Too many room commands. Try again shortly.';
    case 'already_connected':
      return 'This participant is already connected.';
    case 'resume_lost':
      return 'Another connection resumed this membership.';
    default:
      return null;
  }
}

function terminalResumeMessage(error: string): string {
  if (error === 'participant_not_found') return 'The live room reset. Join again.';
  if (error === 'room_ended') return 'This room has ended.';
  return 'The connection was gone too long. Join again.';
}

const EXPIRED = 'The connection was gone too long. Join again.';

/** Owns page-memory credentials, the retry budget, and disposal of obsolete bindings. */
export class RecoveryController {
  private identity: ResumeIdentity | null = null;
  private epoch = 0;
  private deadline = 0;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private readonly leaveRequests = new WeakMap<RoomConnection, Promise<CommandAck>>();

  constructor(
    private readonly roomId: string,
    private readonly host: RecoveryHost,
  ) {}

  get hasCredential(): boolean {
    return this.identity !== null;
  }

  remember(participantId: string, resumeCredential?: string): void {
    this.identity = resumeCredential ? { participantId, resumeCredential } : null;
  }

  cancel(dropCredential = true): void {
    this.epoch += 1;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
    if (dropCredential) this.identity = null;
  }

  start(): void {
    this.cancel(false);
    const epoch = this.epoch;
    this.deadline = Date.now() + RECONNECT_GRACE_MS;
    for (const delay of [1000, 2000, 4000])
      this.timers.push(setTimeout(() => void this.attempt(epoch), delay));
    this.timers.push(
      setTimeout(() => {
        if (epoch === this.epoch) this.fail(EXPIRED);
      }, RECONNECT_GRACE_MS),
    );
    void this.attempt(epoch);
  }

  requestLeave(active: RoomConnection): Promise<CommandAck> {
    const pending = this.leaveRequests.get(active);
    if (pending) return pending;
    const result = active.leave();
    this.leaveRequests.set(active, result);
    return result;
  }

  private async attempt(epoch: number): Promise<void> {
    if (epoch !== this.epoch || !this.host.canRecover() || !this.identity) return;
    if (Date.now() >= this.deadline) {
      this.fail(EXPIRED);
      return;
    }
    const identity = this.identity;
    const previous = this.host.connection;
    this.host.setConnection(null);
    previous?.close();
    let active: RoomConnection | null = null;
    try {
      active = this.host.open((result) => {
        if (active) this.complete(active, result, epoch);
      });
      this.host.setConnection(active);
      const result = await active.resume({ roomId: this.roomId, ...identity });
      if (result.ok) {
        this.complete(active, result, epoch);
        return;
      }
      if (epoch !== this.epoch || this.host.connection !== active) return;
      const retryable = retryableResumeMessage(result.error);
      if (retryable) {
        this.host.setConnection(null);
        active.close();
        if (this.host.canRecover()) this.host.retrying(retryable);
        return;
      }
      this.fail(terminalResumeMessage(result.error));
      if (result.error === 'room_ended') this.host.ended();
    } catch {
      active?.close();
      if (this.host.connection === active) this.host.setConnection(null);
      // Keep the absolute schedule. The final attempt may wait until grace ends.
    }
  }

  private complete(active: RoomConnection, result: Resumed, epoch: number): void {
    if (this.host.connection === active && this.host.hasJoined()) return;
    if (
      epoch === this.epoch &&
      this.host.connection === active &&
      this.host.canRecover() &&
      Date.now() >= this.deadline
    ) {
      void this.requestLeave(active).catch(() => undefined);
      this.fail(EXPIRED);
      return;
    }
    if (epoch !== this.epoch || this.host.connection !== active || !this.host.canRecover()) {
      void this.requestLeave(active).then(
        () => active.close(),
        () => active.close(),
      );
      return;
    }
    this.cancel(false);
    this.host.resumed(active, result);
  }

  private fail(message: string): void {
    const active = this.host.connection;
    this.host.setConnection(null);
    this.cancel();
    active?.close();
    this.host.failed(message);
  }
}
