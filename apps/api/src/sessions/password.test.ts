import { expect, it } from 'vitest';
import { hashPassword, verifyPassword } from './password';

it('hashes at cost 12 and verifies only the matching password', async () => {
  const password = 'test-password';
  const passwordHash = await hashPassword(password);
  expect(passwordHash).toContain('$12$');
  expect(passwordHash).not.toContain(password);
  expect(await verifyPassword(password, passwordHash)).toBe(true);
  expect(await verifyPassword('different-password', passwordHash)).toBe(false);
}, 10_000);
