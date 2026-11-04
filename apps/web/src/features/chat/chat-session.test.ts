import { describe, expect, it, vi } from 'vitest';
import type { ChatHistoryAck, ChatMessage, ChatSendAck } from '@stageflow/shared';
import { ChatSession, type ChatTransport } from './chat-session';

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
      .mockResolvedValueOnce(history([message(1), message(2), message(3)], { latestSequence: 5 }));
    session.receive(message(5));
    await settle();
    expect(transport.chatHistory).toHaveBeenLastCalledWith({ beforeSequence: 4, limit: 100 });
    expect(session.getSnapshot().messages.map((item) => item.sequence)).toEqual([1, 2, 3, 4, 5]);
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
