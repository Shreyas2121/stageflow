import type { SessionsService } from '../sessions/sessions.service';
import type { User } from '../users/user.entity';

// LiveConnection permits one API writer per namespace. Local credential changes
// invalidate immediately; a five-second lease bounds freshness for external edits.
export class SocketAuthorization {
  private checkedAt = Date.now();
  private pending?: Promise<boolean>;
  private timer?: ReturnType<typeof setTimeout>;
  private revoked = false;

  constructor(
    private readonly sessions: SessionsService,
    private readonly token: string,
    private readonly user: User,
    private readonly deadline: number,
    private readonly disconnect: () => void,
  ) {
    this.scheduleExpiry();
  }

  private scheduleExpiry(): void {
    const remaining = this.deadline - Date.now();
    if (remaining <= 0) {
      this.revoke();
      return;
    }
    this.timer = setTimeout(() => this.scheduleExpiry(), Math.min(remaining, 2_147_483_647));
    this.timer.unref();
  }

  revoke(): void {
    if (this.revoked) return;
    this.revoked = true;
    this.dispose();
    this.disconnect();
  }

  valid(): boolean | Promise<boolean> {
    if (this.revoked || Date.now() >= this.deadline) {
      this.revoke();
      return false;
    }
    if (Date.now() - this.checkedAt < 5000) return true;
    this.pending ??= this.sessions
      .verifyToken(this.token)
      .then((user) => {
        if (
          user.id !== this.user.id ||
          user.sessionVersion !== this.user.sessionVersion ||
          user.isGuest !== this.user.isGuest
        )
          return false;
        this.checkedAt = Date.now();
        return !this.revoked && Date.now() < this.deadline;
      })
      .catch(() => false)
      .then((valid) => {
        if (!valid) this.revoke();
        return valid;
      })
      .finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }

  dispose(): void {
    clearTimeout(this.timer);
  }
}
