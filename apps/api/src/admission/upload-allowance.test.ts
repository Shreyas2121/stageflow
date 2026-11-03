import { expect, it } from 'vitest';
import { UploadAllowance } from './upload-allowance';

const limits = {
  UPLOAD_USER_RATE_LIMIT: 3,
  UPLOAD_ATTEMPT_RATE_LIMIT: 1,
  RATE_WINDOW_MS: 60_000,
  RATE_KEYS_MAX: 10,
};

it('separates a host user allowance from each broadcast attempt', () => {
  let now = 0;
  const allowance = new UploadAllowance(limits, () => now);
  expect(allowance.limit('host', 'attempt-a')).toBeNull();
  expect(allowance.limit('host', 'attempt-a')).toBe(60);
  expect(allowance.limit('host', 'attempt-b')).toBeNull();
  expect(allowance.limit('host', 'attempt-c')).toBe(60);
  expect(allowance.limit('other', 'attempt-d')).toBeNull();
  now = 60_000;
  expect(allowance.limit('host', 'attempt-a')).toBeNull();
});
