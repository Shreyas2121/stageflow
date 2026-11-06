import { describe, expect, it } from 'vitest';
import {
  createRoomSlug,
  createRoomSlugFromCrypto,
  parseDisplayName,
  isScheduledStartAt,
  parseRoomJoinTarget,
  parseRoomMode,
  parseRoomTitle,
  parseCreateRoomRequest,
} from './contracts';

describe('parseCreateRoomRequest', () => {
  const immediate = { title: 'Review', mode: 'MEETING' };
  const scheduled = {
    ...immediate,
    status: 'SCHEDULED',
    scheduledStartAt: '2000-01-01T00:00:00.123Z',
  };

  it.each([true, false])('keeps title/mode create immediate for isGuest=%s', (isGuest) => {
    expect(parseCreateRoomRequest(immediate, isGuest)).toEqual({
      ok: true,
      value: { ...immediate, status: 'LIVE', scheduledStartAt: null, requireAdmission: false },
    });
  });
  it.each(['MEETING', 'WEBINAR'])('accepts a past schedule for a registered %s host', (mode) => {
    expect(parseCreateRoomRequest({ ...scheduled, mode }, false)).toEqual({
      ok: true,
      value: { ...scheduled, mode, requireAdmission: false },
    });
  });
  it.each([
    { status: 'LIVE' },
    { status: undefined },
    { scheduledStartAt: null },
    { requireAdmission: false },
    { requireAdmission: undefined },
  ])('rejects every scheduling field for a guest: %j', (fields) => {
    expect(parseCreateRoomRequest({ ...immediate, ...fields }, true)).toEqual({
      ok: false,
      error: 'schedule_not_allowed',
      message: 'Create a host account before scheduling a room.',
    });
  });
  it.each(['ENDED', 'scheduled', null, undefined, 1])('rejects invalid status %j', (status) => {
    expect(parseCreateRoomRequest({ ...immediate, status }, false)).toEqual({
      ok: false,
      error: 'invalid_schedule',
      message: 'Choose a live or scheduled room.',
    });
  });
  it.each([
    undefined,
    null,
    '',
    '2026-02-30T00:00:00.000Z',
    '2026-11-05T12:00:00Z',
    '2026-11-05T12:00:00.000+00:00',
  ])('rejects invalid scheduled instant %j', (scheduledStartAt) => {
    expect(parseCreateRoomRequest({ ...scheduled, scheduledStartAt }, false)).toEqual({
      ok: false,
      error: 'invalid_schedule',
      message: 'Enter a UTC start time.',
    });
  });
  it.each([null, '2000-01-01T00:00:00.000Z'])(
    'rejects a start field on LIVE: %j',
    (scheduledStartAt) => {
      expect(
        parseCreateRoomRequest({ ...immediate, status: 'LIVE', scheduledStartAt }, false),
      ).toMatchObject({
        ok: false,
        error: 'invalid_schedule',
        message: 'Enter a UTC start time.',
      });
    },
  );
  it('allows admission on a meeting and rejects it on a webinar', () => {
    expect(parseCreateRoomRequest({ ...scheduled, requireAdmission: true }, false)).toMatchObject({
      ok: true,
      value: { requireAdmission: true },
    });
    expect(
      parseCreateRoomRequest({ ...scheduled, mode: 'WEBINAR', requireAdmission: true }, false),
    ).toEqual({
      ok: false,
      error: 'invalid_admission',
      message: 'Admission applies to meetings only.',
    });
  });
  it.each([null, undefined, 'true', 1])('rejects nonboolean admission %j', (requireAdmission) => {
    expect(parseCreateRoomRequest({ ...scheduled, requireAdmission }, false)).toMatchObject({
      ok: false,
      error: 'invalid_admission',
    });
  });
  it.each([null, [], {}, { ...immediate, title: '' }, { ...immediate, mode: 'OTHER' }])(
    'retains title/mode validation for %j',
    (body) => {
      expect(parseCreateRoomRequest(body, false).ok).toBe(false);
    },
  );
});

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
    expect(() =>
      createRoomSlug(() => {
        draws += 1;
        return 255;
      }),
    ).toThrow('slug_source_exhausted');
    expect(draws).toBe(32);
  });

  it('resets the rejection limit after an accepted byte', () => {
    let draws = 0;
    expect(createRoomSlug(() => (++draws % 32 === 0 ? 0 : 255))).toBe('A'.repeat(12));
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

describe('parseRoomJoinTarget', () => {
  const origin = 'https://stageflow.test';
  const slug = 'Ab12Cd34Ef56';
  const failure = {
    ok: false as const,
    error: 'invalid_room_link' as const,
    message: 'Enter a room slug or a link to a room on this app.',
  };

  it('accepts a slug, the room path, and an absolute url on the supplied origin', () => {
    expect(parseRoomJoinTarget(slug, origin)).toEqual({ ok: true, value: slug });
    expect(parseRoomJoinTarget(`  ${slug}  `, origin)).toEqual({ ok: true, value: slug });
    expect(parseRoomJoinTarget(`/r/${slug}`, origin)).toEqual({ ok: true, value: slug });
    expect(parseRoomJoinTarget(`  /r/${slug}  `, origin)).toEqual({ ok: true, value: slug });
    expect(parseRoomJoinTarget(`${origin}/r/${slug}`, origin)).toEqual({ ok: true, value: slug });
    expect(parseRoomJoinTarget(`  ${origin}/r/${slug}  `, origin)).toEqual({
      ok: true,
      value: slug,
    });
    expect(
      parseRoomJoinTarget('http://localhost:5173/r/Ab12Cd34Ef56', 'http://localhost:5173'),
    ).toEqual({ ok: true, value: slug });
  });

  it.each([
    `${origin}/replay/550e8400-e29b-41d4-a716-446655440000`,
    '/replay/550e8400-e29b-41d4-a716-446655440000',
    `https://evil.example/r/${slug}`,
    `${origin}/r/${slug}?next=1`,
    `/r/${slug}?next=1`,
    `${origin}/r/${slug}#hash`,
    `/r/${slug}#hash`,
    'Ab12Cd34Ef5',
    `//stageflow.test/r/${slug}`,
    `${origin}/r/${slug}/extra`,
    `/r/${slug}/extra`,
    `https://user:pass@stageflow.test/r/${slug}`,
    `/r/${slug}\\extra`,
    `${origin}/r/${slug}\\extra`,
    `https://stageflow.test:443/r/${slug}`,
  ])('rejects %s', (input) => {
    expect(parseRoomJoinTarget(input, origin)).toEqual(failure);
  });
});

describe('isScheduledStartAt', () => {
  it.each(['2000-01-01T00:00:00.000Z', '2099-12-31T23:59:59.999Z', '2024-02-29T12:00:00.123Z'])(
    'accepts canonical UTC instants including past times: %s',
    (value) => {
      expect(isScheduledStartAt(value)).toBe(true);
    },
  );
  it.each([
    null,
    undefined,
    42,
    '',
    '2026-02-30T00:00:00.000Z',
    '2026-13-01T00:00:00.000Z',
    '2026-11-05T12:00:00Z',
    '2026-11-05T12:00:00.000+00:00',
    '2026-11-05T24:00:00.000Z',
    ' 2026-11-05T12:00:00.000Z',
    '2026-11-05T12:00:00.000000Z',
  ])('rejects noncanonical or invalid instants: %j', (value) => {
    expect(isScheduledStartAt(value)).toBe(false);
  });
});
