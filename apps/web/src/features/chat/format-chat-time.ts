type Formatters = {
  calendar: Intl.DateTimeFormat;
  time: Intl.DateTimeFormat;
  dateTime: Intl.DateTimeFormat;
};

const formatters = new Map<string, Formatters>();
const MAX_FORMATTER_CONTEXTS = 8;

function getFormatters(locale?: string, timeZone?: string): Formatters {
  const key = JSON.stringify([locale, timeZone]);
  const cached = formatters.get(key);
  if (cached) return cached;

  const calendarOptions = { timeZone, year: 'numeric', month: 'numeric', day: 'numeric' } as const;
  const timeOptions = { timeZone, hour: 'numeric', minute: '2-digit' } as const;
  const created = {
    calendar: new Intl.DateTimeFormat(locale, calendarOptions),
    time: new Intl.DateTimeFormat(locale, timeOptions),
    dateTime: new Intl.DateTimeFormat(locale, {
      ...timeOptions,
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    }),
  };
  if (formatters.size >= MAX_FORMATTER_CONTEXTS) {
    formatters.delete(formatters.keys().next().value!);
  }
  formatters.set(key, created);
  return created;
}

export function getChatTimeContext(now = Date.now()) {
  // Resolve defaults outside the message loop so system settings can change while chat is open.
  const { locale, timeZone } = new Intl.DateTimeFormat().resolvedOptions();
  return { now, locale, timeZone, day: getFormatters(locale, timeZone).calendar.format(now) };
}

export function formatChatTime(
  sentAt: number,
  now: number,
  locale?: string,
  timeZone?: string,
): { dateTime: string; text: string } | null {
  if (!Number.isFinite(sentAt)) return null;

  try {
    const dateTime = new Date(sentAt).toISOString();
    const { calendar, time, dateTime: dated } = getFormatters(locale, timeZone);
    const sameDay = calendar.format(sentAt) === calendar.format(now);
    const text = (sameDay ? time : dated).format(sentAt);

    return { dateTime, text };
  } catch {
    return null;
  }
}
