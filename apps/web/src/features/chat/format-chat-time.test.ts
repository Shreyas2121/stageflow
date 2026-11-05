import { describe, expect, it, vi } from 'vitest';
import { formatChatTime } from './format-chat-time';

const now = Date.parse('2026-11-04T16:00:00.000Z');

describe('formatChatTime', () => {
  it('shows the local hour and minute without a date on the same day', () => {
    const time = formatChatTime(Date.parse('2026-11-04T14:05:00.000Z'), now, 'en-GB', 'UTC');

    expect(time?.dateTime).toBe('2026-11-04T14:05:00.000Z');
    expect(time?.text).toBe('14:05');
    expect(time?.text).not.toContain('2026');
  });

  it('includes the day, month, year, and time on another local day', () => {
    const time = formatChatTime(Date.parse('2026-11-03T14:05:00.000Z'), now, 'en-GB', 'UTC');

    expect(time?.dateTime).toBe('2026-11-03T14:05:00.000Z');
    expect(time?.text).toContain('3 Nov 2026');
    expect(time?.text).toContain('14:05');
  });

  it('compares calendar days in the requested time zone', () => {
    const sentAt = Date.parse('2026-11-04T23:30:00.000Z');
    const nextUtcDay = Date.parse('2026-11-05T00:30:00.000Z');

    expect(formatChatTime(sentAt, nextUtcDay, 'en-GB', 'America/New_York')).toEqual({
      dateTime: '2026-11-04T23:30:00.000Z',
      text: '18:30',
    });
    expect(formatChatTime(sentAt, nextUtcDay, 'en-GB', 'UTC')?.text).toContain('4 Nov 2026');
  });

  it('adds the date when local midnight passes, including a year boundary', () => {
    const sentAt = Date.parse('2026-12-31T18:29:00.000Z');
    const beforeMidnight = Date.parse('2026-12-31T18:29:59.999Z');
    const midnight = Date.parse('2026-12-31T18:30:00.000Z');

    expect(formatChatTime(sentAt, beforeMidnight, 'en-GB', 'Asia/Kolkata')?.text).toBe('23:59');
    expect(formatChatTime(sentAt, midnight, 'en-GB', 'Asia/Kolkata')?.text).toBe(
      '31 Dec 2026, 23:59',
    );
  });

  it('keeps the time alone across a daylight-saving clock change on the same day', () => {
    expect(
      formatChatTime(
        Date.parse('2026-11-01T05:30:00.000Z'),
        Date.parse('2026-11-01T06:30:00.000Z'),
        'en-GB',
        'America/New_York',
      )?.text,
    ).toBe('1:30');
  });

  it('uses the newly selected locale and time zone', () => {
    const sentAt = Date.parse('2026-11-04T14:05:00.000Z');
    expect(formatChatTime(sentAt, now, 'en-US', 'UTC')?.text).toBe('2:05 PM');
    expect(formatChatTime(sentAt, now, 'en-GB', 'UTC')?.text).toBe('14:05');
    expect(formatChatTime(sentAt, now, 'en-GB', 'Asia/Kolkata')?.text).toBe('19:35');
  });

  it('reuses locale/time-zone formatters over full transcripts and day changes', async () => {
    vi.resetModules();
    const { formatChatTime: format } = await import('./format-chat-time');
    const constructors = vi.spyOn(Intl, 'DateTimeFormat');
    try {
      for (let index = 0; index < 500; index++) {
        expect(format(now - index * 60_000, now, 'en-GB', 'UTC')).not.toBeNull();
      }
      const initialCount = constructors.mock.calls.length;
      expect(initialCount).toBeLessThanOrEqual(3);
      for (let index = 0; index < 500; index++) {
        expect(format(now - index * 60_000, now + 86_400_000, 'en-GB', 'UTC')?.text).toContain(
          'Nov 2026',
        );
      }
      expect(constructors).toHaveBeenCalledTimes(initialCount);
      expect(format(now, now, 'en-US', 'Asia/Kolkata')?.text).toBe('9:30 PM');
      const changedCount = constructors.mock.calls.length;
      expect(changedCount).toBeGreaterThan(initialCount);
      format(now, now, 'en-US', 'Asia/Kolkata');
      expect(constructors).toHaveBeenCalledTimes(changedCount);
    } finally {
      constructors.mockRestore();
    }
  });

  it('omits invalid current times, locales, and time zones without poisoning later calls', () => {
    expect(formatChatTime(now, NaN, 'en-GB', 'UTC')).toBeNull();
    expect(formatChatTime(now, now, 'invalid_locale', 'UTC')).toBeNull();
    expect(formatChatTime(now, now, 'en-GB', 'Invalid/Zone')).toBeNull();
    expect(formatChatTime(now, now, 'en-GB', 'UTC')?.text).toBe('16:00');
  });

  it.each([NaN, Infinity, -Infinity, 8.64e15 + 1])('omits an invalid instant (%s)', (sentAt) => {
    expect(formatChatTime(sentAt, now, 'en-GB', 'UTC')).toBeNull();
  });
});
