import type { ApiConfig } from '../config/parse-config';
import { retryAfterSeconds, WindowBudget } from './window-budget';

type UploadLimits = Pick<
  ApiConfig,
  'UPLOAD_USER_RATE_LIMIT' | 'UPLOAD_ATTEMPT_RATE_LIMIT' | 'RATE_WINDOW_MS' | 'RATE_KEYS_MAX'
>;

// Call only after the authenticated user is confirmed as the attempt's host.
// A different user must not be able to spend that host's allowance.
export class UploadAllowance {
  private readonly users: WindowBudget;
  private readonly attempts: WindowBudget;
  constructor(config: UploadLimits, now?: () => number) {
    this.users = new WindowBudget(
      config.UPLOAD_USER_RATE_LIMIT,
      config.RATE_WINDOW_MS,
      config.RATE_KEYS_MAX,
      now,
    );
    this.attempts = new WindowBudget(
      config.UPLOAD_ATTEMPT_RATE_LIMIT,
      config.RATE_WINDOW_MS,
      config.RATE_KEYS_MAX,
      now,
    );
  }
  /** Retry-After seconds when the host exceeds the user or attempt allowance. */
  limit(userId: string, attemptId: string): number | null {
    if (!this.users.consume(userId)) return retryAfterSeconds(this.users.blockedForMs(userId));
    if (!this.attempts.consume(attemptId))
      return retryAfterSeconds(this.attempts.blockedForMs(attemptId));
    return null;
  }
}
