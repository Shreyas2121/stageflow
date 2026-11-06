import {
  parseQaSubmit,
  type QaQuestionIdRequest,
  type QaSetSubmissionsRequest,
  type QaState,
  type QaStateAck,
  type QaSubmitRequest,
} from '@stageflow/shared';

export type QaTransport = {
  qaState(): Promise<QaStateAck>;
  qaSubmit(request: QaSubmitRequest): Promise<QaStateAck>;
  qaVote(request: QaQuestionIdRequest): Promise<QaStateAck>;
  qaDismiss(request: QaQuestionIdRequest): Promise<QaStateAck>;
  qaFeature(request: QaQuestionIdRequest): Promise<QaStateAck>;
  qaClearFeature(): Promise<QaStateAck>;
  qaSetSubmissions(request: QaSetSubmissionsRequest): Promise<QaStateAck>;
};

type State = QaState & {
  phase: 'idle' | 'joined' | 'recovering' | 'closed';
  votedQuestionIds: string[];
  draft: string;
  pending: boolean;
  ready: boolean;
  error: string;
};

const emptyBoard = (): QaState => ({ submissionsOpen: true, featured: null, questions: [] });

/** Q&A owns its acknowledgements; it has no media or stage dependencies. */
export class QaSession {
  private state: State = {
    ...emptyBoard(),
    phase: 'idle',
    votedQuestionIds: [],
    draft: '',
    pending: false,
    ready: false,
    error: '',
  };
  private transport: QaTransport | null = null;
  private participantId: string | null = null;
  private epoch = 0;
  private boardVersion = 0;
  private readonly listeners = new Set<() => void>();

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  readonly getSnapshot = (): State => this.state;
  get visible(): boolean {
    return this.state.phase !== 'idle';
  }
  get canAct(): boolean {
    return this.state.phase === 'joined' && this.state.ready && !this.state.pending;
  }

  connect(transport: QaTransport, participantId: string): void {
    if (this.transport === transport && this.participantId === participantId) return;
    this.invalidate();
    if (this.participantId !== participantId) {
      this.update({ ...emptyBoard(), votedQuestionIds: [], draft: '' });
    }
    this.participantId = participantId;
    this.transport = transport;
    this.update({ phase: 'joined', ready: false, error: '' });
    void this.refresh();
  }
  suspend(recovering = true): void {
    this.invalidate();
    this.update({ phase: recovering && this.visible ? 'recovering' : 'idle', ready: false });
  }
  end(): void {
    const visible = this.visible;
    this.invalidate();
    this.update({ phase: visible ? 'closed' : 'idle', ready: false });
  }
  setDraft(draft: string): void {
    this.update({ draft });
  }
  receive(board: QaState): void {
    if (this.state.phase !== 'joined') return;
    this.boardVersion += 1;
    this.applyBoard(board);
  }
  refresh(): Promise<void> {
    return this.run((transport) => transport.qaState());
  }
  async ask(): Promise<void> {
    if (!this.canAct || !this.state.submissionsOpen) return;
    const parsed = parseQaSubmit({ text: this.state.draft });
    if (!parsed.ok) {
      this.update({
        error: 'Enter a question from 1 to 200 characters and at most 1,000 UTF-8 bytes.',
      });
      return;
    }
    const draft = this.state.draft;
    await this.run(
      (transport) => transport.qaSubmit(parsed.value),
      () => {
        if (this.state.draft === draft) this.update({ draft: '' });
      },
    );
  }
  vote(questionId: string): Promise<void> {
    return this.run((transport) => transport.qaVote({ questionId }));
  }
  dismiss(questionId: string): Promise<void> {
    return this.run((transport) => transport.qaDismiss({ questionId }));
  }
  feature(questionId: string): Promise<void> {
    return this.run((transport) => transport.qaFeature({ questionId }));
  }
  clearFeature(): Promise<void> {
    return this.run((transport) => transport.qaClearFeature());
  }
  setSubmissions(open: boolean): Promise<void> {
    return this.run((transport) => transport.qaSetSubmissions({ open }));
  }

  private async run(
    action: (transport: QaTransport) => Promise<QaStateAck>,
    success?: () => void,
  ): Promise<void> {
    const transport = this.transport;
    if (!transport || this.state.phase !== 'joined' || this.state.pending) return;
    const epoch = this.epoch;
    const boardVersion = this.boardVersion;
    this.update({ pending: true, error: '' });
    try {
      const ack = await action(transport);
      if (epoch !== this.epoch) return;
      if (!ack.ok) {
        this.update({ error: ack.message });
        return;
      }
      // A newer room event must survive an older state/command acknowledgement.
      if (boardVersion === this.boardVersion) this.applyBoard(ack);
      const ids = new Set(this.state.questions.map((question) => question.id));
      this.update({
        votedQuestionIds: ack.votedQuestionIds.filter((id) => ids.has(id)),
        ready: true,
      });
      success?.();
    } catch {
      if (epoch === this.epoch)
        this.update({ error: 'Questions could not be confirmed. Try again shortly.' });
    } finally {
      if (epoch === this.epoch) this.update({ pending: false });
    }
  }
  private applyBoard(board: QaState): void {
    const ids = new Set(board.questions.map((question) => question.id));
    this.update({
      submissionsOpen: board.submissionsOpen,
      featured: board.featured,
      questions: board.questions,
      votedQuestionIds: this.state.votedQuestionIds.filter((id) => ids.has(id)),
    });
  }
  private invalidate(): void {
    this.epoch += 1;
    this.transport = null;
    this.update({ pending: false });
  }
  private update(patch: Partial<State>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
}
