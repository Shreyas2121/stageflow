import { describe, expect, it, vi } from 'vitest';
import type { QaStateAck } from '@stageflow/shared';
import { QaSession } from './qa-session';

import { ack, board, question, transport } from './qa-test-fixtures';

const tick = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
async function joined() {
  const session = new QaSession();
  const wire = transport();
  session.connect(wire, 'self');
  await tick();
  return { session, wire };
}

describe('question session', () => {
  it('reads state only after connect and keeps stable snapshots until a notification', async () => {
    const session = new QaSession();
    const wire = transport();
    const listener = vi.fn();
    const unsubscribe = session.subscribe(listener);
    expect(session.visible).toBe(false);
    const before = session.getSnapshot();
    expect(session.getSnapshot()).toBe(before);
    session.connect(wire, 'self');
    await tick();
    session.connect(wire, 'self');
    expect(wire.qaState).toHaveBeenCalledOnce();
    expect(session.canAct).toBe(true);
    expect(listener).toHaveBeenCalled();
    unsubscribe();
    listener.mockClear();
    session.setDraft('New');
    expect(listener).not.toHaveBeenCalled();
  });
  it('trims and validates, blocks duplicate in-flight asks, and clears only a confirmed draft', async () => {
    const { session, wire } = await joined();
    for (const text of ['', 'x'.repeat(201), 'a\nb']) {
      session.setDraft(text);
      await session.ask();
    }
    expect(wire.qaSubmit).not.toHaveBeenCalled();
    expect(session.getSnapshot().error).toContain('1 to 200');
    let finish!: (value: QaStateAck) => void;
    wire.qaSubmit.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    session.setDraft('  Hello  ');
    const sending = session.ask();
    await session.ask();
    expect(wire.qaSubmit).toHaveBeenCalledExactlyOnceWith({ text: 'Hello' });
    expect(session.canAct).toBe(false);
    expect(session.getSnapshot().draft).toBe('  Hello  ');
    finish(ack());
    await sending;
    expect(session.getSnapshot().draft).toBe('');
  });
  it('retains the draft after a lost or rejected ack and recovers without replaying it', async () => {
    const { session, wire } = await joined();
    session.setDraft('Keep me');
    wire.qaSubmit.mockRejectedValueOnce(new Error('timeout'));
    await session.ask();
    expect(session.getSnapshot()).toMatchObject({ draft: 'Keep me', pending: false });
    expect(session.getSnapshot().error).toContain('could not be confirmed');
    wire.qaSubmit.mockResolvedValueOnce({ ok: false, error: 'qa_closed', message: 'Closed' });
    await session.ask();
    expect(session.getSnapshot().error).toBe('Closed');
    session.suspend();
    expect(session.canAct).toBe(false);
    const next = transport();
    session.connect(next, 'self');
    await tick();
    expect(next.qaState).toHaveBeenCalledOnce();
    expect(next.qaSubmit).not.toHaveBeenCalled();
  });
  it('preserves private votes across public counts and discards them on dismissal or a new membership', async () => {
    const { session, wire } = await joined();
    await session.vote('1');
    session.receive({ ...board, questions: [{ ...question, voteCount: 2 }] });
    expect(session.getSnapshot().votedQuestionIds).toEqual(['1']);
    expect(session.getSnapshot().questions[0]?.voteCount).toBe(2);
    await session.vote('1');
    expect(wire.qaVote).toHaveBeenCalledTimes(2);
    session.receive({ ...board, questions: [] });
    expect(session.getSnapshot().votedQuestionIds).toEqual([]);
    session.suspend();
    session.connect(transport(), 'new');
    await tick();
    expect(session.getSnapshot().votedQuestionIds).toEqual([]);
  });
  it('does not replace a newer public board with an older ack and still applies private votes', async () => {
    const { session, wire } = await joined();
    let finish!: (value: QaStateAck) => void;
    wire.qaVote.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const voting = session.vote('1');
    session.receive({
      ...board,
      submissionsOpen: false,
      questions: [{ ...question, voteCount: 3 }],
    });
    finish(ack({ votedQuestionIds: ['1'] }));
    await voting;
    expect(session.getSnapshot()).toMatchObject({
      submissionsOpen: false,
      votedQuestionIds: ['1'],
      questions: [{ voteCount: 3 }],
    });
  });
  it('runs host commands while closed; preserves retained questions on end and ignores stale replies/events', async () => {
    const { session, wire } = await joined();
    await session.setSubmissions(false);
    session.setDraft('Closed');
    await session.ask();
    expect(wire.qaSubmit).not.toHaveBeenCalled();
    await session.feature('1');
    expect(session.getSnapshot().featured?.questionId).toBe('1');
    await session.clearFeature();
    expect(session.getSnapshot().featured).toBeNull();
    await session.dismiss('1');
    expect(session.getSnapshot().questions).toEqual([]);
    session.receive(board);
    let finish!: (value: QaStateAck) => void;
    wire.qaState.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const refreshing = session.refresh();
    session.end();
    finish(ack({ questions: [] }));
    await refreshing;
    session.receive({ ...board, questions: [] });
    await session.vote('1');
    expect(session.getSnapshot()).toMatchObject({
      phase: 'closed',
      questions: [question],
      pending: false,
    });
    expect(session.visible).toBe(true);
    expect(session.canAct).toBe(false);
    expect(wire.qaVote).not.toHaveBeenCalled();
  });
  it('allows retry of an initial state failure and ignores replies from an obsolete connection', async () => {
    const wire = transport();
    const session = new QaSession();
    wire.qaState.mockRejectedValueOnce(new Error('offline'));
    session.connect(wire, 'self');
    await tick();
    expect(session.canAct).toBe(false);
    await session.refresh();
    expect(session.canAct).toBe(true);
    let finish!: (value: QaStateAck) => void;
    wire.qaState.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const refresh = session.refresh();
    session.suspend();
    session.connect(transport(), 'self');
    await tick();
    finish(ack({ questions: [] }));
    await refresh;
    expect(session.getSnapshot().questions).toEqual([question]);
  });
});
