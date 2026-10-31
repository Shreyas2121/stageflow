import { describe, expect, it } from 'vitest';
import {
  createRoomSlug,
  createRoomSlugFromCrypto,
  parseDisplayName,
  parseRoomMode,
  parseRoomTitle,
} from './contracts';

describe('parseDisplayName', () => {
  it.each(['', '   ', 'a'.repeat(41), 'Ava\nLee', null, undefined, 42, {}, []])(
    'rejects invalid input %j with the contract error',
    (input) => {
      expect(parseDisplayName(input)).toEqual({
        ok: false,
        error: 'invalid_display_name',
        message: 'Enter a display name from 1 to 40 characters.',
      });
    },
  );

  it.each(['A', 'a'.repeat(40), 'Ava'])('accepts and trims %j', (value) => {
    expect(parseDisplayName(`  ${value}  `)).toEqual({ ok: true, value });
  });

  it('rejects every ASCII control character inside a name', () => {
    for (const code of [...Array.from({ length: 32 }, (_, index) => index), 127]) {
      expect(parseDisplayName(`A${String.fromCharCode(code)}B`).ok).toBe(false);
    }
  });
});

describe('parseRoomTitle', () => {
  it.each(['', '   ', 'a'.repeat(81), 'Design\nreview', null, undefined, 42, {}, []])(
    'rejects invalid input %j with the contract error',
    (input) => {
      expect(parseRoomTitle(input)).toEqual({
        ok: false,
        error: 'invalid_title',
        message: 'Enter a title from 1 to 80 characters.',
      });
    },
  );

  it.each(['A', 'a'.repeat(80), 'Design review'])('accepts and trims %j', (value) => {
    expect(parseRoomTitle(`  ${value}  `)).toEqual({ ok: true, value });
  });

  it('rejects every ASCII control character inside a title', () => {
    for (const code of [...Array.from({ length: 32 }, (_, index) => index), 127]) {
      expect(parseRoomTitle(`A${String.fromCharCode(code)}B`).ok).toBe(false);
    }
  });
});

describe('parseRoomMode', () => {
  it.each(['MEETING', 'WEBINAR'])('accepts the exact mode %s', (value) => {
    expect(parseRoomMode(value)).toEqual({ ok: true, value });
  });

  it.each(['meeting', 'webinar', ' MEETING ', '', 'CLASS', null, undefined, 1, {}])(
    'rejects invalid mode %j',
    (input) => {
      expect(parseRoomMode(input)).toEqual({
        ok: false,
        error: 'invalid_mode',
        message: 'Choose a meeting or a webinar.',
      });
    },
  );
});

describe('createRoomSlug', () => {
  it('skips rejected bytes and resumes drawing until there are 12 characters', () => {
    const bytes = [0, 248, 249, 250, 251, 252, 253, 254, 255];
    let draws = 0;
    const slug = createRoomSlug(() => bytes[draws++] ?? 61);
    expect(slug).toBe('A99999999999');
    expect(draws).toBe(20);
    expect(slug).toMatch(/^[A-Za-z0-9]{12}$/);
  });

  it('maps accepted bytes uniformly across all four complete alphabet ranges', () => {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let byte = 0; byte < 248; byte += 1) {
      expect(createRoomSlug(() => byte)).toBe(alphabet.charAt(byte % 62).repeat(12));
    }
  });

  it('throws after 32 consecutive rejected bytes', () => {
    let draws = 0;
    expect(() => createRoomSlug(() => {
      draws += 1;
      return 255;
    })).toThrow('slug_source_exhausted');
    expect(draws).toBe(32);
  });

  it('resets the rejection limit after an accepted byte', () => {
    let draws = 0;
    expect(createRoomSlug(() => ++draws % 32 === 0 ? 0 : 255)).toBe('A'.repeat(12));
    expect(draws).toBe(384);
  });

  it('can produce different slugs from different byte sequences', () => {
    expect(createRoomSlug(() => 0)).not.toBe(createRoomSlug(() => 1));
  });
});

describe('createRoomSlugFromCrypto', () => {
  it('uses the runtime crypto source to produce a valid slug', () => {
    expect(createRoomSlugFromCrypto()).toMatch(/^[A-Za-z0-9]{12}$/);
  });
});
