import { describe, expect, it } from 'vitest';
import { parseEmail, parsePassword } from './account';

describe('parseEmail', () => {
  const failure = {
    ok: false,
    error: 'invalid_email',
    message: 'Enter a valid email address.',
  };

  it.each([
    ['Ava@Example.com', 'ava@example.com'],
    ['  Ava@Example.com  ', 'ava@example.com'],
    ['a@b.co', 'a@b.co'],
    [`${'a'.repeat(249)}@b.co`, `${'a'.repeat(249)}@b.co`],
  ])('accepts and normalizes %j', (input, value) => {
    expect(parseEmail(input)).toEqual({ ok: true, value });
  });

  it.each([
    '',
    '   ',
    'ava',
    'ava@',
    '@example.com',
    'ava@example',
    'ava example@example.com',
    'ava@example .com',
    'ava\u00a0lee@example.com',
    'ava@@example.com',
    'ava@example@com',
    'ava@.example.com',
    'ava@example.com.',
    '\n',
    `${'a'.repeat(250)}@b.co`,
    null,
    undefined,
    42,
    {},
    [],
  ])('rejects invalid input %j with the contract error', (input) => {
    expect(parseEmail(input)).toEqual(failure);
  });

  it('rejects every ASCII control character, including around the address', () => {
    for (const code of [...Array.from({ length: 32 }, (_, index) => index), 127]) {
      const control = String.fromCharCode(code);
      expect(parseEmail(`${control}ava@example.com`)).toEqual(failure);
      expect(parseEmail(`ava${control}@example.com`)).toEqual(failure);
      expect(parseEmail(`ava@example.com${control}`)).toEqual(failure);
    }
  });
});

describe('parsePassword', () => {
  const failure = {
    ok: false,
    error: 'invalid_password',
    message: 'Use 8 to 72 characters, without control characters.',
  };

  it.each([
    'a'.repeat(8),
    'a'.repeat(72),
    'é'.repeat(36),
    '😀'.repeat(18),
    ` ${'a'.repeat(8)}`,
    `${'a'.repeat(8)} `,
    ` ${'a'.repeat(8)} `,
  ])('accepts %j without changing it', (value) => {
    expect(parsePassword(value)).toEqual({ ok: true, value });
  });

  it.each([
    '',
    'a'.repeat(7),
    'a'.repeat(73),
    'é'.repeat(37),
    '😀'.repeat(19),
    '😀'.repeat(7),
    `${'a'.repeat(6)}😀`,
    `\n${'a'.repeat(8)}`,
    null,
    undefined,
    42,
    {},
    [],
  ])('rejects invalid input %j with the contract error', (input) => {
    expect(parsePassword(input)).toEqual(failure);
  });

  it('rejects every ASCII control character at any position', () => {
    for (const code of [...Array.from({ length: 32 }, (_, index) => index), 127]) {
      const control = String.fromCharCode(code);
      expect(parsePassword(`${control}${'a'.repeat(8)}`)).toEqual(failure);
      expect(parsePassword(`aaaa${control}aaaa`)).toEqual(failure);
      expect(parsePassword(`${'a'.repeat(8)}${control}`)).toEqual(failure);
    }
  });
});
