import { afterAll, expect, it } from 'vitest';
import { closePasswordWorkers, hashPassword, verifyPassword } from './password';

afterAll(() => closePasswordWorkers());

it('hashes at cost 12 and verifies only the matching UTF-8 password', async () => {
  const password = 'pässwörd-test';
  const passwordHash = await hashPassword(password);
  expect(passwordHash).toContain('$12$');
  expect(passwordHash).not.toContain(password);
  expect(await verifyPassword(password, passwordHash)).toBe(true);
  expect(await verifyPassword('different-password', passwordHash)).toBe(false);
}, 10_000);
