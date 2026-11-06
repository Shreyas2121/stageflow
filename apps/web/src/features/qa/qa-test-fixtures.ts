import { vi } from 'vitest';
import type { QaState, QaStateAck } from '@stageflow/shared';
import type { QaTransport } from './qa-session';

export const question = {
  id: '1',
  text: '<b>hi</b>',
  authorName: '<Sam>',
  authorParticipantId: 'sam',
  createdAt: 1,
  voteCount: 0,
};
export const board: QaState = { questions: [question], featured: null, submissionsOpen: true };
export const ack = (
  patch: Partial<Extract<QaStateAck, { ok: true }>> = {},
): Extract<QaStateAck, { ok: true }> => ({ ok: true, ...board, votedQuestionIds: [], ...patch });
export function transport() {
  return {
    qaState: vi.fn<QaTransport['qaState']>(async () => ack()),
    qaSubmit: vi.fn<QaTransport['qaSubmit']>(async () => ack()),
    qaVote: vi.fn<QaTransport['qaVote']>(async () => ack({ votedQuestionIds: ['1'] })),
    qaDismiss: vi.fn<QaTransport['qaDismiss']>(async () => ack({ questions: [] })),
    qaFeature: vi.fn<QaTransport['qaFeature']>(async () =>
      ack({ featured: { questionId: '1', text: question.text, authorName: question.authorName } }),
    ),
    qaClearFeature: vi.fn<QaTransport['qaClearFeature']>(async () => ack()),
    qaSetSubmissions: vi.fn<QaTransport['qaSetSubmissions']>(async ({ open }) =>
      ack({ submissionsOpen: open }),
    ),
  };
}
