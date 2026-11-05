import type { ParseResult } from './contracts';

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}

export function parseEmail(input: unknown): ParseResult<string> {
  const failure: ParseResult<string> = {
    ok: false,
    error: 'invalid_email',
    message: 'Enter a valid email address.',
  };
  if (typeof input !== 'string' || hasControlCharacter(input)) return failure;

  const value = input.trim().toLowerCase();
  const at = value.indexOf('@');
  const domain = value.slice(at + 1);
  if (
    value.length < 3 ||
    value.length > 254 ||
    /\s/.test(value) ||
    at <= 0 ||
    at !== value.lastIndexOf('@') ||
    !domain.includes('.') ||
    domain.startsWith('.') ||
    domain.endsWith('.')
  ) {
    return failure;
  }

  return { ok: true, value };
}

export function parsePassword(input: unknown): ParseResult<string> {
  if (
    typeof input !== 'string' ||
    input.length > 72 ||
    Array.from(input).length < 8 ||
    hasControlCharacter(input) ||
    new TextEncoder().encode(input).byteLength > 72
  ) {
    return {
      ok: false,
      error: 'invalid_password',
      message: 'Use 8 to 72 characters, without control characters.',
    };
  }

  return { ok: true, value: input };
}
