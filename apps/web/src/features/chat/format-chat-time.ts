export function formatChatTime(
  sentAt: number,
  now: number,
  locale?: string,
  timeZone?: string,
): { dateTime: string; text: string } | null {
  if (!Number.isFinite(sentAt)) return null;

  try {
    const dateTime = new Date(sentAt).toISOString();
    const calendarDate = new Intl.DateTimeFormat(locale, {
      timeZone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
    });
    const sameDay = calendarDate.format(sentAt) === calendarDate.format(now);
    const text = new Intl.DateTimeFormat(locale, {
      timeZone,
      hour: 'numeric',
      minute: '2-digit',
      ...(sameDay ? {} : ({ year: 'numeric', month: 'short', day: 'numeric' } as const)),
    }).format(sentAt);

    return { dateTime, text };
  } catch {
    return null;
  }
}
