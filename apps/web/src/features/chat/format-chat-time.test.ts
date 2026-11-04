import { describe, expect, it } from 'vitest';
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

  it.each([NaN, Infinity, -Infinity, 8.64e15 + 1])('omits an invalid instant (%s)', (sentAt) => {
    expect(formatChatTime(sentAt, now, 'en-GB', 'UTC')).toBeNull();
  });
});
