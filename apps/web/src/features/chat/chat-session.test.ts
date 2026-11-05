import { describe, expect, it, vi } from 'vitest';
import {
  CHAT_MESSAGE_RETENTION,
  type ChatHistoryAck,
  type ChatMessage,
  type ChatSendAck,
} from '@stageflow/shared';
import {
  CHAT_MAX_RETAINED_ATTEMPTS,
  CHAT_MAX_RETAINED_TEXT_BYTES,
  ChatSession,
  type ChatTransport,
} from './chat-session';

function message(sequence: number, text = `Line ${sequence}`): ChatMessage {
  return {
    sequence,
    text,
    participantId: 'ava',
    displayName: 'Ava',
    role: 'HOST',
    sentAt: sequence,
  };
}
function history(
  messages: ChatMessage[] = [],
  extra: Partial<Extract<ChatHistoryAck, { ok: true }>> = {},
): ChatHistoryAck {
  return {
    ok: true,
    messages,
    paused: false,
    oldestSequence: messages[0]?.sequence ?? null,
    latestSequence: messages.at(-1)?.sequence ?? null,
    retentionGap: false,
    ...extra,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function settle() {
  for (let index = 0; index < 20; index++) await Promise.resolve();
}
function harness() {
  const session = new ChatSession();
  const transport = {
    chatHistory: vi.fn<ChatTransport['chatHistory']>(async () => history()),
    chatSend: vi.fn<ChatTransport['chatSend']>(async () => ({ ok: true, message: message(1) })),
    chatSetPaused: vi.fn<ChatTransport['chatSetPaused']>(async ({ paused }) => ({
      ok: true,
      paused,
    })),
  };
  return { session, transport };
}

function attemptTextBytes(session: ChatSession): number {
  return session
    .getSnapshot()
    .attempts.reduce(
      (total, attempt) => total + new TextEncoder().encode(attempt.text).byteLength,
      0,
    );
}

describe('ChatSession', () => {
  it('hides before join and loads history only after connect', async () => {
    const { session, transport } = harness();
    expect(session.visible).toBe(false);
    expect(transport.chatHistory).not.toHaveBeenCalled();
    session.connect(transport);
    expect(session.visible).toBe(true);
    expect(session.canSend).toBe(false);
    await settle();
    expect(transport.chatHistory).toHaveBeenCalledExactlyOnceWith({});
    expect(session.canSend).toBe(true);
  });

  it('applies history, early live delivery, and an ack once in server order', async () => {
    const { session, transport } = harness();
    const pending = deferred<ChatHistoryAck>();
    transport.chatHistory.mockReturnValueOnce(pending.promise);
    session.receive(message(2));
    session.connect(transport);
    session.receive(message(3));
    pending.resolve(history([message(1), message(2)]));
    await settle();
    session.receive(message(1, 'stale'));
    session.setDraft('  hello\nroom  ');
    transport.chatSend.mockResolvedValueOnce({ ok: true, message: message(3) });
    session.sendDraft();
    await settle();
    expect(session.getSnapshot().messages).toEqual([message(1), message(2), message(3)]);
    expect(transport.chatSend).toHaveBeenCalledWith({
      requestId: expect.any(String),
      text: 'hello\nroom',
    });
    expect(session.getSnapshot().attempts).toEqual([]);
  });

  it('fetches one hole while duplicate live messages arrive', async () => {
    const { session, transport } = harness();
    transport.chatHistory.mockResolvedValueOnce(history([message(1)]));
    session.connect(transport);
    await settle();
    const pending = deferred<ChatHistoryAck>();
    transport.chatHistory.mockReturnValueOnce(pending.promise);
    session.receive(message(4));
    expect(session.canSend).toBe(true);
    session.receive(message(4));
    session.receive(message(3));
    expect(transport.chatHistory).toHaveBeenCalledTimes(2);
    pending.resolve(history([message(1), message(2), message(3), message(4)]));
    await settle();
    expect(session.getSnapshot().messages.map((item) => item.sequence)).toEqual([1, 2, 3, 4]);
    expect(transport.chatHistory).toHaveBeenCalledTimes(2);
  });

  it('pages back to fill a hole larger than the latest page', async () => {
    const { session, transport } = harness();
    transport.chatHistory.mockResolvedValueOnce(history([message(1)]));
    session.connect(transport);
    await settle();
    transport.chatHistory
      .mockResolvedValueOnce(history([message(4), message(5)], { oldestSequence: 1 }))
      .mockResolvedValueOnce(history([message(2), message(3)], { latestSequence: 5 }));
    session.receive(message(5));
    await settle();
    expect(transport.chatHistory).toHaveBeenLastCalledWith({ beforeSequence: 4, limit: 100 });
    expect(session.getSnapshot().messages.map((item) => item.sequence)).toEqual([1, 2, 3, 4, 5]);
    expect(session.getSnapshot().retentionGap).toBe(false);
    session.receive(message(6));
    expect(session.getSnapshot().messages.at(-1)).toEqual(message(6));
    expect(transport.chatHistory).toHaveBeenCalledTimes(3);
  });

  it('fills from an early live delivery when the initial recent page starts later', async () => {
    const { session, transport } = harness();
    const latest = deferred<ChatHistoryAck>();
    transport.chatHistory
      .mockReturnValueOnce(latest.promise)
      .mockResolvedValueOnce(
        history([message(2), message(3)], { oldestSequence: 2, latestSequence: 5 }),
      );
    session.connect(transport);
    session.receive(message(2));
    latest.resolve(history([message(4), message(5)], { oldestSequence: 2 }));
    await settle();
    expect(session.getSnapshot().messages).toEqual([
      message(2),
      message(3),
      message(4),
      message(5),
    ]);
    expect(session.getSnapshot().retentionGap).toBe(false);
    expect(transport.chatHistory).toHaveBeenLastCalledWith({ beforeSequence: 4, limit: 100 });
  });

  it('exposes a trimmed hole and keeps lines already on the page', async () => {
    const { session, transport } = harness();
    transport.chatHistory.mockResolvedValueOnce(history([message(1)]));
    session.connect(transport);
    await settle();
    transport.chatHistory.mockResolvedValueOnce(history([message(8), message(9)]));
    session.receive(message(9));
    await settle();
    expect(session.getSnapshot().retentionGap).toBe(true);
    expect(session.getSnapshot().messages.map((item) => item.sequence)).toEqual([1, 8, 9]);
  });

  it('detects retention advancing during backfill and advances past the exposed gap', async () => {
    const { session, transport } = harness();
    transport.chatHistory.mockResolvedValueOnce(history([message(1)]));
    session.connect(transport);
    await settle();
    transport.chatHistory
      .mockResolvedValueOnce(history([message(4), message(5)], { oldestSequence: 1 }))
      .mockResolvedValueOnce(history([message(3)], { oldestSequence: 3, latestSequence: 7 }));
    session.receive(message(5));
    await settle();
    expect(session.getSnapshot().retentionGap).toBe(true);
    expect(session.getSnapshot().messages).toEqual([
      message(1),
      message(3),
      message(4),
      message(5),
    ]);
    expect(transport.chatHistory).toHaveBeenCalledTimes(3);

    // The completed range ends at the first page's target, not a later page's metadata.
    session.receive(message(2));
    session.receive(message(6));
    session.receive(message(7));
    expect(session.getSnapshot().messages.map((item) => item.sequence)).toEqual([1, 3, 4, 5, 6, 7]);
    expect(transport.chatHistory).toHaveBeenCalledTimes(3);
  });

  it('detects an empty page at the exact oldest boundary without a server gap flag', async () => {
    const { session, transport } = harness();
    transport.chatHistory.mockResolvedValueOnce(history([message(1)]));
    session.connect(transport);
    await settle();
    transport.chatHistory
      .mockResolvedValueOnce(history([message(4), message(5)], { oldestSequence: 1 }))
      .mockResolvedValueOnce(history([], { oldestSequence: 4, latestSequence: 6 }));
    session.receive(message(5));
    await settle();
    expect(transport.chatHistory).toHaveBeenLastCalledWith({ beforeSequence: 4, limit: 100 });
    expect(session.getSnapshot()).toMatchObject({ retentionGap: true, error: '', loading: false });
    session.receive(message(6));
    expect(session.getSnapshot().messages.map((item) => item.sequence)).toEqual([1, 4, 5, 6]);
    expect(transport.chatHistory).toHaveBeenCalledTimes(3);
  });

  it('uses concurrent live messages and acknowledgements to cover a trimmed history range', async () => {
    const { session, transport } = harness();
    transport.chatHistory.mockResolvedValueOnce(history([message(1)]));
    session.connect(transport);
    await settle();
    const older = deferred<ChatHistoryAck>();
    const sent = deferred<ChatSendAck>();
    transport.chatHistory
      .mockResolvedValueOnce(history([message(4), message(5)], { oldestSequence: 1 }))
      .mockReturnValueOnce(older.promise);
    transport.chatSend.mockReturnValueOnce(sent.promise);
    session.receive(message(5));
    await settle();
    session.setDraft('Line 2');
    session.sendDraft();
    session.receive(message(3));
    session.receive(message(6));
    sent.resolve({ ok: true, message: message(2) });
    await settle();
    older.resolve(history([message(3)], { oldestSequence: 3, latestSequence: 6 }));
    await settle();
    expect(session.getSnapshot()).toMatchObject({ retentionGap: false, error: '', attempts: [] });
    expect(session.getSnapshot().messages).toEqual(
      Array.from({ length: 6 }, (_, i) => message(i + 1)),
    );
    expect(transport.chatHistory).toHaveBeenCalledTimes(3);
  });

  it.each(['empty', 'rejected', 'timeout'] as const)(
    'keeps an interrupted range retryable when the backfill result is %s',
    async (result) => {
      const { session, transport } = harness();
      transport.chatHistory.mockResolvedValueOnce(history([message(1)]));
      session.connect(transport);
      await settle();
      transport.chatHistory.mockResolvedValueOnce(
        history([message(4), message(5)], { oldestSequence: 1 }),
      );
      if (result === 'empty')
        transport.chatHistory.mockResolvedValueOnce(
          history([], { oldestSequence: 1, latestSequence: 5 }),
        );
      else if (result === 'rejected')
        transport.chatHistory.mockResolvedValueOnce({
          ok: false,
          error: 'chat_busy',
          message: 'Try again.',
        });
      else transport.chatHistory.mockRejectedValueOnce(new Error('timeout'));
      session.receive(message(5));
      await settle();
      expect(session.getSnapshot()).toMatchObject({
        retentionGap: false,
        loading: false,
        messages: [message(1)],
      });
      expect(session.getSnapshot().error).not.toBe('');
      expect(transport.chatHistory).toHaveBeenCalledTimes(3);

      const retry = deferred<ChatHistoryAck>();
      transport.chatHistory.mockReturnValueOnce(retry.promise);
      session.receive(message(2));
      expect(session.getSnapshot().messages).toEqual([message(1), message(2)]);
      expect(transport.chatHistory).toHaveBeenCalledTimes(4);
      retry.resolve(history([message(3), message(4)], { oldestSequence: 1, latestSequence: 4 }));
      await settle();
      expect(session.getSnapshot()).toMatchObject({
        retentionGap: false,
        error: '',
        loading: false,
      });
      expect(session.getSnapshot().messages).toEqual(
        Array.from({ length: 5 }, (_, i) => message(i + 1)),
      );
    },
  );

  it('rejects a noncontiguous history range without advancing or losing buffered messages', async () => {
    const { session, transport } = harness();
    transport.chatHistory.mockResolvedValueOnce(history([message(1)]));
    session.connect(transport);
    await settle();
    transport.chatHistory.mockResolvedValueOnce(
      history([message(2), message(4)], { oldestSequence: 1 }),
    );
    session.receive(message(5));
    await settle();
    expect(session.getSnapshot()).toMatchObject({ retentionGap: false, messages: [message(1)] });
    expect(session.getSnapshot().error).not.toBe('');
    transport.chatHistory.mockResolvedValueOnce(
      history([message(2), message(3), message(4)], { oldestSequence: 1 }),
    );
    await session.refresh();
    expect(session.getSnapshot().messages).toEqual(
      Array.from({ length: 5 }, (_, i) => message(i + 1)),
    );
    expect(session.getSnapshot().retentionGap).toBe(false);
  });

  it('ignores an obsolete backfill reply after suspension and fills the range on reconnect', async () => {
    const { session, transport } = harness();
    transport.chatHistory.mockResolvedValueOnce(history([message(1)]));
    session.connect(transport);
    await settle();
    const older = deferred<ChatHistoryAck>();
    transport.chatHistory
      .mockResolvedValueOnce(history([message(4), message(5)], { oldestSequence: 1 }))
      .mockReturnValueOnce(older.promise);
    session.receive(message(5));
    await settle();
    session.suspend();
    older.resolve(history([], { oldestSequence: 4, latestSequence: 5 }));
    await settle();
    expect(session.getSnapshot()).toMatchObject({
      phase: 'recovering',
      retentionGap: false,
      messages: [message(1)],
    });
    transport.chatHistory
      .mockResolvedValueOnce(history([message(4), message(5)], { oldestSequence: 1 }))
      .mockResolvedValueOnce(history([message(1), message(2), message(3)], { latestSequence: 5 }));
    session.connect(transport);
    await settle();
    expect(session.getSnapshot().messages).toEqual(
      Array.from({ length: 5 }, (_, i) => message(i + 1)),
    );
    expect(session.getSnapshot().retentionGap).toBe(false);
  });

  it('keeps history and live buffers bounded and preserves an overflow warning during backfill', async () => {
    const { session, transport } = harness();
    transport.chatHistory.mockResolvedValueOnce(history([message(1)]));
    session.connect(transport);
    await settle();
    const latest = deferred<ChatHistoryAck>();
    const retained = Array.from({ length: CHAT_MESSAGE_RETENTION }, (_, i) => message(i + 502));
    transport.chatHistory
      .mockReturnValueOnce(latest.promise)
      .mockImplementation(async ({ beforeSequence, limit = 50 }) =>
        history(
          retained.filter((item) => item.sequence < (beforeSequence ?? Infinity)).slice(-limit),
          {
            oldestSequence: 502,
            latestSequence: 1001,
          },
        ),
      );
    session.receive(message(1001));
    for (let sequence = 1002; sequence <= 1501; sequence++) session.receive(message(sequence));
    expect(session.getSnapshot().retentionGap).toBe(true);
    latest.resolve(history(retained.slice(-50), { oldestSequence: 502, latestSequence: 1001 }));
    await settle();
    expect(transport.chatHistory).toHaveBeenCalledTimes(7);
    expect(session.getSnapshot()).toMatchObject({ retentionGap: true, loading: false, error: '' });
    expect(session.getSnapshot().messages).toEqual(
      Array.from({ length: CHAT_MESSAGE_RETENTION }, (_, i) => message(i + 1002)),
    );
    session.receive(message(1502));
    expect(session.getSnapshot().messages).toHaveLength(CHAT_MESSAGE_RETENTION);
    expect(session.getSnapshot().messages.at(-1)).toEqual(message(1502));
    expect(transport.chatHistory).toHaveBeenCalledTimes(7);
  });

  it('honors an explicit retention gap in history', async () => {
    const { session, transport } = harness();
    transport.chatHistory.mockResolvedValueOnce(history([], { retentionGap: true }));
    session.connect(transport);
    await settle();
    expect(session.getSnapshot().retentionGap).toBe(true);
  });

  it('keeps the sixth draft and sends at most five unacknowledged requests', async () => {
    const { session, transport } = harness();
    transport.chatSend.mockImplementation(() => new Promise(() => undefined));
    session.connect(transport);
    await settle();
    for (let index = 0; index < 6; index++) {
      session.setDraft(`draft ${index}`);
      session.sendDraft();
    }
    expect(transport.chatSend).toHaveBeenCalledTimes(5);
    expect(session.getSnapshot().draft).toBe('draft 5');
    expect(session.getSnapshot().error).toBe('Chat is busy. Try again shortly.');
    session.end();
  });

  it('bounds sustained sequential failures without evicting old attempts or losing the draft', async () => {
    const { session, transport } = harness();
    transport.chatSend.mockResolvedValue({ ok: false, error: 'chat_busy', message: 'Try again.' });
    session.connect(transport);
    await settle();
    for (let index = 0; index < CHAT_MAX_RETAINED_ATTEMPTS * 5; index++) {
      session.setDraft(`Draft ${index}`);
      session.sendDraft();
      await settle();
      expect(session.getSnapshot().attempts.length).toBeLessThanOrEqual(CHAT_MAX_RETAINED_ATTEMPTS);
      expect(attemptTextBytes(session)).toBeLessThanOrEqual(CHAT_MAX_RETAINED_TEXT_BYTES);
    }
    expect(transport.chatSend).toHaveBeenCalledTimes(CHAT_MAX_RETAINED_ATTEMPTS);
    expect(session.sendLimitReached).toBe(true);
    expect(session.getSnapshot().attempts.map(({ requestId }) => requestId)).toEqual(
      transport.chatSend.mock.calls.map(([request]) => request.requestId),
    );
    expect(session.getSnapshot().attempts.every(({ status }) => status === 'failed')).toBe(true);
    expect(session.getSnapshot().draft).toBe(`Draft ${CHAT_MAX_RETAINED_ATTEMPTS * 5 - 1}`);
  });

  it('enforces the exact UTF-8 text-byte cap before the attempt count cap and releases bytes on dismissal', async () => {
    const { session, transport } = harness();
    transport.chatSend.mockRejectedValue(new Error('timeout'));
    session.connect(transport);
    await settle();
    const text = '\u754c'.repeat(1000);
    for (let index = 0; index < 13; index++) {
      session.setDraft(` \n${text}\t `);
      session.sendDraft();
      await settle();
    }
    expect(attemptTextBytes(session)).toBe(39_000);
    session.setDraft('\u754c'.repeat(334));
    expect(session.sendLimitReached).toBe(true);
    session.sendDraft();
    expect(transport.chatSend).toHaveBeenCalledTimes(13);
    expect(session.getSnapshot().draft).toBe('\u754c'.repeat(334));
    session.setDraft('a'.repeat(1000));
    expect(session.sendLimitReached).toBe(false);
    session.sendDraft();
    await settle();
    expect(attemptTextBytes(session)).toBe(CHAT_MAX_RETAINED_TEXT_BYTES);
    expect(session.getSnapshot().attempts).toHaveLength(14);
    expect(session.sendLimitReached).toBe(true);

    session.setDraft('a');
    session.sendDraft();
    await settle();
    expect(transport.chatSend).toHaveBeenCalledTimes(14);
    expect(session.getSnapshot().draft).toBe('a');
    expect(attemptTextBytes(session)).toBe(CHAT_MAX_RETAINED_TEXT_BYTES);

    const request = transport.chatSend.mock.calls[0]![0];
    session.retry(request.requestId);
    await settle();
    expect(transport.chatSend).toHaveBeenLastCalledWith(request);
    expect(attemptTextBytes(session)).toBe(CHAT_MAX_RETAINED_TEXT_BYTES);
    session.dismiss(request.requestId);
    expect(attemptTextBytes(session)).toBe(37_000);
    expect(session.sendLimitReached).toBe(false);
    session.setDraft(text);
    session.sendDraft();
    await settle();
    expect(session.getSnapshot().draft).toBe('');
    expect(attemptTextBytes(session)).toBe(CHAT_MAX_RETAINED_TEXT_BYTES);
    expect(session.getSnapshot().attempts).toHaveLength(14);
  });

  it('preserves mixed pending and failed attempts and still enforces five concurrent sends', async () => {
    const { session, transport } = harness();
    transport.chatSend.mockResolvedValue({ ok: false, error: 'chat_busy', message: 'Try again.' });
    session.connect(transport);
    await settle();
    for (let index = 0; index < CHAT_MAX_RETAINED_ATTEMPTS - 5; index++) {
      session.setDraft(`Failed ${index}`);
      session.sendDraft();
      await settle();
    }
    const pending = deferred<ChatSendAck>();
    transport.chatSend.mockImplementation(() => pending.promise);
    for (let index = 0; index < 5; index++) {
      session.setDraft(`Pending ${index}`);
      session.sendDraft();
    }
    const attempts = session.getSnapshot().attempts;
    expect(attempts).toHaveLength(CHAT_MAX_RETAINED_ATTEMPTS);
    expect(session.sendLimitReached).toBe(true);
    session.setDraft('Keep this draft');
    session.sendDraft();
    session.retry(attempts[0]!.requestId);
    session.dismiss(attempts.at(-1)!.requestId);
    expect(session.getSnapshot().attempts).toEqual(attempts);
    expect(session.getSnapshot().draft).toBe('Keep this draft');
    expect(transport.chatSend).toHaveBeenCalledTimes(CHAT_MAX_RETAINED_ATTEMPTS);

    session.dismiss(attempts[0]!.requestId);
    session.sendDraft();
    expect(session.getSnapshot().attempts).toHaveLength(CHAT_MAX_RETAINED_ATTEMPTS - 1);
    expect(session.getSnapshot().draft).toBe('Keep this draft');
    expect(transport.chatSend).toHaveBeenCalledTimes(CHAT_MAX_RETAINED_ATTEMPTS);
    pending.resolve({ ok: true, message: message(1) });
    await settle();
    expect(session.getSnapshot().attempts).toHaveLength(CHAT_MAX_RETAINED_ATTEMPTS - 6);
    session.sendDraft();
    await settle();
    expect(transport.chatSend).toHaveBeenCalledTimes(CHAT_MAX_RETAINED_ATTEMPTS + 1);
    expect(session.getSnapshot().draft).toBe('');
  });

  it('allows repeated same-id retries at the count cap and admits a new draft only after space is freed', async () => {
    const { session, transport } = harness();
    transport.chatSend.mockResolvedValue({ ok: false, error: 'chat_busy', message: 'Try again.' });
    session.connect(transport);
    await settle();
    for (let index = 0; index < CHAT_MAX_RETAINED_ATTEMPTS; index++) {
      session.setDraft(`Failed ${index}`);
      session.sendDraft();
      await settle();
    }
    const request = transport.chatSend.mock.calls[0]![0];
    const originalIds = session
      .getSnapshot()
      .attempts.map(({ requestId }) => requestId)
      .sort();
    const originalBytes = attemptTextBytes(session);
    session.setDraft('Keep until there is space');
    for (let index = 0; index < 5; index++) {
      session.retry(request.requestId);
      await settle();
      expect(transport.chatSend).toHaveBeenLastCalledWith(request);
      expect(
        session
          .getSnapshot()
          .attempts.map(({ requestId }) => requestId)
          .sort(),
      ).toEqual(originalIds);
      expect(attemptTextBytes(session)).toBe(originalBytes);
    }
    session.sendDraft();
    expect(transport.chatSend).toHaveBeenCalledTimes(CHAT_MAX_RETAINED_ATTEMPTS + 5);
    expect(session.getSnapshot().draft).toBe('Keep until there is space');
    session.dismiss(request.requestId);
    session.sendDraft();
    await settle();
    expect(transport.chatSend).toHaveBeenCalledTimes(CHAT_MAX_RETAINED_ATTEMPTS + 6);
    expect(transport.chatSend.mock.calls.at(-1)![0].requestId).not.toBe(request.requestId);
    expect(session.getSnapshot().attempts).toHaveLength(CHAT_MAX_RETAINED_ATTEMPTS);
    expect(session.getSnapshot().draft).toBe('');
  });

  it('keeps a full set and draft across reconnect without replaying sends or accepting late acknowledgements', async () => {
    const { session, transport } = harness();
    transport.chatSend.mockResolvedValue({ ok: false, error: 'chat_busy', message: 'Try again.' });
    session.connect(transport);
    await settle();
    for (let index = 0; index < CHAT_MAX_RETAINED_ATTEMPTS - 1; index++) {
      session.setDraft(`Failed ${index}`);
      session.sendDraft();
      await settle();
    }
    const pending = deferred<ChatSendAck>();
    transport.chatSend.mockReturnValueOnce(pending.promise);
    session.setDraft('Uncertain send');
    session.sendDraft();
    const requests = transport.chatSend.mock.calls.map(([request]) => request);
    session.setDraft('Unsent draft');
    session.suspend();
    session.connect(transport);
    await settle();
    pending.resolve({ ok: true, message: message(1) });
    await settle();
    expect(transport.chatSend).toHaveBeenCalledTimes(CHAT_MAX_RETAINED_ATTEMPTS);
    expect(session.getSnapshot().attempts.every(({ status }) => status === 'failed')).toBe(true);
    expect(
      session.getSnapshot().attempts.map(({ requestId, text }) => ({ requestId, text })),
    ).toEqual(requests);
    session.sendDraft();
    expect(transport.chatSend).toHaveBeenCalledTimes(CHAT_MAX_RETAINED_ATTEMPTS);
    expect(session.getSnapshot().draft).toBe('Unsent draft');

    transport.chatSend.mockResolvedValueOnce({ ok: true, message: message(1) });
    const retry = requests.at(-1)!;
    session.retry(retry.requestId);
    await settle();
    expect(transport.chatSend).toHaveBeenLastCalledWith(retry);
    expect(session.getSnapshot().attempts).toHaveLength(CHAT_MAX_RETAINED_ATTEMPTS - 1);
    session.sendDraft();
    await settle();
    expect(session.getSnapshot().attempts).toHaveLength(CHAT_MAX_RETAINED_ATTEMPTS);
    expect(session.getSnapshot().draft).toBe('');
  });

  it('marks uncertain sends failed, ignores late acks, refetches on resume, and retries the same id explicitly', async () => {
    const { session, transport } = harness();
    const pending = deferred<ChatSendAck>();
    transport.chatSend.mockReturnValueOnce(pending.promise);
    session.connect(transport);
    await settle();
    session.setDraft('Question');
    session.sendDraft();
    const request = transport.chatSend.mock.calls[0]![0];
    session.suspend();
    expect(session.visible).toBe(true);
    expect(session.canSend).toBe(false);
    expect(session.getSnapshot().attempts[0]?.status).toBe('failed');
    session.sendDraft();
    session.retry(request.requestId);
    transport.chatHistory.mockResolvedValueOnce(history([message(1, 'Question')]));
    session.connect(transport);
    await settle();
    pending.resolve({ ok: true, message: message(1, 'Question') });
    await settle();
    expect(transport.chatSend).toHaveBeenCalledTimes(1);
    expect(session.getSnapshot().attempts[0]?.status).toBe('failed');
    transport.chatSend.mockResolvedValueOnce({ ok: true, message: message(1, 'Question') });
    session.retry(request.requestId);
    await settle();
    expect(transport.chatSend).toHaveBeenLastCalledWith(request);
    expect(session.getSnapshot().messages).toEqual([message(1, 'Question')]);
    expect(session.getSnapshot().attempts).toEqual([]);
  });

  it.each(['chat_busy', 'chat_rate_limited', 'stale_transport'] as const)(
    'keeps %s local with explicit retry or dismissal',
    async (error) => {
      const { session, transport } = harness();
      transport.chatSend.mockResolvedValueOnce({ ok: false, error, message: 'Try again.' });
      session.connect(transport);
      await settle();
      session.setDraft('Question');
      session.sendDraft();
      await settle();
      expect(session.getSnapshot().phase).toBe('joined');
      expect(session.canSend).toBe(true);
      const attempt = session.getSnapshot().attempts[0]!;
      expect(attempt).toMatchObject({ status: 'failed', error: 'Try again.' });
      session.dismiss(attempt.requestId);
      expect(transport.chatSend).toHaveBeenCalledTimes(1);
    },
  );

  it('pauses everyone, survives stale history metadata, and resumes through its own transport', async () => {
    const { session, transport } = harness();
    const pending = deferred<ChatHistoryAck>();
    transport.chatHistory.mockReturnValueOnce(pending.promise);
    session.connect(transport);
    session.receivePaused(true);
    pending.resolve(history());
    await settle();
    expect(session.getSnapshot().paused).toBe(true);
    session.setDraft('blocked');
    session.sendDraft();
    expect(transport.chatSend).not.toHaveBeenCalled();
    await session.setPaused(false);
    expect(transport.chatSetPaused).toHaveBeenCalledExactlyOnceWith({ paused: false });
    expect(session.canSend).toBe(true);
    transport.chatSend.mockResolvedValueOnce({
      ok: false,
      error: 'chat_paused',
      message: 'The host paused chat.',
    });
    session.sendDraft();
    await settle();
    expect(session.getSnapshot().paused).toBe(true);
    expect(session.getSnapshot().attempts[0]?.status).toBe('failed');
  });

  it('keeps ended lines and rejects all further sends and late history', async () => {
    const { session, transport } = harness();
    transport.chatHistory.mockResolvedValueOnce(history([message(1)]));
    session.connect(transport);
    await settle();
    const pending = deferred<ChatHistoryAck>();
    transport.chatHistory.mockReturnValueOnce(pending.promise);
    const refresh = session.refresh();
    session.end();
    session.setDraft('closed');
    session.sendDraft();
    pending.resolve(history([message(2)]));
    await refresh;
    session.receive(message(3));
    await session.setPaused(false);
    expect(session.visible).toBe(true);
    expect(session.canSend).toBe(false);
    expect(session.getSnapshot().messages).toEqual([message(1)]);
    expect(transport.chatSend).not.toHaveBeenCalled();
    expect(transport.chatSetPaused).not.toHaveBeenCalled();
  });

  it('keeps validation, history, pause, and timeout failures on the chat state', async () => {
    const { session, transport } = harness();
    transport.chatHistory.mockRejectedValueOnce(new Error('timeout'));
    session.connect(transport);
    await settle();
    expect(session.getSnapshot().error).toBe('Unable to load chat. Try again.');
    await session.refresh();
    session.setDraft(' '.repeat(4));
    session.sendDraft();
    expect(session.getSnapshot().draft).toBe('    ');
    expect(transport.chatSend).not.toHaveBeenCalled();
    transport.chatSetPaused.mockRejectedValueOnce(new Error('timeout'));
    await session.setPaused(true);
    expect(session.getSnapshot().pausePending).toBe(false);
    transport.chatSend.mockRejectedValueOnce(new Error('timeout'));
    session.setDraft('<b>plain</b> https://example.com');
    session.sendDraft();
    await settle();
    expect(session.getSnapshot().attempts[0]).toMatchObject({
      text: '<b>plain</b> https://example.com',
      status: 'failed',
    });
    expect(session.getSnapshot().phase).toBe('joined');
  });
});
