import { expect, it } from 'vitest';
import { createRoomSlug, isRoomSlug, isUuid } from './identifiers';
it.each([NaN, -1, 256, Infinity, 1.5])('rejects invalid slug source %s immediately', (value) => {
  let draws = 0;
  expect(() =>
    createRoomSlug(() => {
      draws++;
      return value;
    }),
  ).toThrow('invalid_slug_byte');
  expect(draws).toBe(1);
});
it('shares exact slug and UUID validation', () => {
  expect(isRoomSlug('Ab0123456789')).toBe(true);
  for (const value of [null, {}, 'a'.repeat(11), 'a'.repeat(13), 'a'.repeat(11) + '_'])
    expect(isRoomSlug(value)).toBe(false);
  expect(isUuid('AAAAAAAA-aaaa-0000-1234-0123456789ab')).toBe(true);
  for (const value of [null, 'host', 'a'.repeat(36), '01234567-89ab-cdef-0123-456789abcdef\n'])
    expect(isUuid(value)).toBe(false);
});
