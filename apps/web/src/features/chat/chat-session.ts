import {
  CHAT_HISTORY_MAX_LIMIT,
  CHAT_MAX_PENDING_SENDS,
  CHAT_MESSAGE_RETENTION,
  parseChatSendRequest,
  type ChatHistoryAck,
  type ChatHistoryRequest,
  type ChatMessage,
  type ChatSendAck,
  type ChatSendRequest,
  type ChatSetPausedAck,
  type ChatSetPausedRequest,
} from '@stageflow/shared';

export type ChatTransport = {
  chatSend(request: ChatSendRequest): Promise<ChatSendAck>;
  chatHistory(request: ChatHistoryRequest): Promise<ChatHistoryAck>;
  chatSetPaused(request: ChatSetPausedRequest): Promise<ChatSetPausedAck>;
};

type Attempt = ChatSendRequest & { status: 'pending' | 'failed'; error: string };
type ChatState = {
  phase: 'idle' | 'joined' | 'recovering' | 'closed';
  messages: ChatMessage[];
  attempts: Attempt[];
  draft: string;
  paused: boolean;
  pausePending: boolean;
  loading: boolean;
  retentionGap: boolean;
  error: string;
};

const BUSY = 'Chat is busy. Try again shortly.';
const UNSENT = 'The acknowledgement was not confirmed. Retry when chat is available.';

/** Owns text and acknowledgements independently of stage/media operations. */
export class ChatSession {
  private state: ChatState = {
    phase: 'idle',
    messages: [],
    attempts: [],
    draft: '',
    paused: false,
    pausePending: false,
    loading: false,
    retentionGap: false,
    error: '',
  };
  private readonly listeners = new Set<() => void>();
  private transport: ChatTransport | null = null;
  private epoch = 0;
  private pauseVersion = 0;
  private appliedThrough: number | null = null;
  private lastGap: number | null = null;
  private readonly buffered = new Map<number, ChatMessage>();

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  readonly getSnapshot = (): ChatState => this.state;

  get visible(): boolean {
    return (
      this.state.phase === 'joined' ||
      this.state.phase === 'recovering' ||
      (this.state.phase === 'closed' &&
        (this.state.messages.length > 0 || this.state.attempts.length > 0))
    );
  }
  get canSend(): boolean {
    return this.state.phase === 'joined' && !this.state.paused && this.appliedThrough !== null;
  }

  connect(transport: ChatTransport): void {
    this.invalidate();
    this.transport = transport;
    this.update({ phase: 'joined' });
    void this.refresh();
  }

  suspend(recovering = true): void {
    this.invalidate();
    this.buffered.clear();
    this.update({ phase: recovering ? 'recovering' : 'idle' });
  }

  end(): void {
    this.invalidate();
    this.buffered.clear();
    this.update({ phase: 'closed' });
  }

  setDraft(draft: string): void {
    this.update({ draft });
  }

  sendDraft(): void {
    if (!this.canSend) return;
    const parsed = parseChatSendRequest({ requestId: crypto.randomUUID(), text: this.state.draft });
    if (!parsed.ok) {
      this.update({ error: 'Enter 1 to 1,000 characters, up to 4,000 bytes.' });
      return;
    }
    if (this.pendingCount() >= CHAT_MAX_PENDING_SENDS) {
      this.update({ error: BUSY });
      return;
    }
    this.update({ draft: '', error: '' });
    void this.send(parsed.value);
  }

  retry(requestId: string): void {
    const attempt = this.state.attempts.find((item) => item.requestId === requestId);
    if (!attempt || attempt.status !== 'failed' || !this.canSend) return;
    if (this.pendingCount() >= CHAT_MAX_PENDING_SENDS) {
      this.update({ error: BUSY });
      return;
    }
    void this.send({ requestId, text: attempt.text });
  }

  dismiss(requestId: string): void {
    this.update({
      attempts: this.state.attempts.filter(
        (item) => item.requestId !== requestId || item.status === 'pending',
      ),
    });
  }

  receivePaused(paused: boolean): void {
    this.pauseVersion += 1;
    this.update({ paused });
  }

  async setPaused(paused: boolean): Promise<void> {
    const transport = this.transport;
    if (!transport || this.state.phase !== 'joined' || this.state.pausePending) return;
    const epoch = this.epoch;
    this.update({ pausePending: true, error: '' });
    try {
      const ack = await transport.chatSetPaused({ paused });
      if (epoch !== this.epoch) return;
      if (ack.ok) this.receivePaused(ack.paused);
      else this.update({ error: ack.message });
    } catch {
      if (epoch === this.epoch) this.update({ error: 'Unable to update chat. Try again.' });
    } finally {
      if (epoch === this.epoch) this.update({ pausePending: false });
    }
  }

  receive(message: ChatMessage): void {
    if (this.state.phase === 'closed' || this.state.phase === 'recovering') return;
    if (this.appliedThrough !== null && message.sequence <= this.appliedThrough) return;
    this.buffered.set(message.sequence, message);
    if (this.buffered.size > CHAT_MESSAGE_RETENTION) {
      this.buffered.delete(Math.min(...this.buffered.keys()));
      this.update({ retentionGap: true });
    }
    if (this.state.phase === 'joined' && !this.state.loading) this.flush();
  }

  /** Latest page first, then bounded older pages when a live delivery exposed a hole. */
  async refresh(): Promise<void> {
    const transport = this.transport;
    if (!transport || this.state.loading || this.state.phase !== 'joined') return;
    const epoch = this.epoch;
    const pauseVersion = this.pauseVersion;
    const baseline = this.appliedThrough;
    let applied = false;
    this.update({ loading: true, error: '' });
    try {
      const latest = await transport.chatHistory({});
      if (epoch !== this.epoch) return;
      if (!latest.ok) {
        this.update({ error: latest.message });
        return;
      }
      let messages = latest.messages;
      let retentionGap = this.state.retentionGap || latest.retentionGap;
      if (baseline !== null) {
        while (
          messages[0] &&
          messages[0].sequence > baseline + 1 &&
          messages[0].sequence > (latest.oldestSequence ?? 0)
        ) {
          const beforeSequence = messages[0].sequence;
          const older = await transport.chatHistory({
            beforeSequence,
            limit: CHAT_HISTORY_MAX_LIMIT,
          });
          if (epoch !== this.epoch) return;
          if (!older.ok) {
            this.update({ error: older.message });
            return;
          }
          retentionGap ||= older.retentionGap;
          if (!older.messages.length) break;
          messages = [...older.messages, ...messages];
          if (messages.length >= CHAT_MESSAGE_RETENTION) break;
        }
        if (latest.oldestSequence !== null && latest.oldestSequence > baseline + 1)
          retentionGap = true;
      }
      this.merge(messages);
      this.appliedThrough = Math.max(baseline ?? 0, latest.latestSequence ?? 0);
      for (const sequence of this.buffered.keys()) {
        if (sequence <= this.appliedThrough) this.buffered.delete(sequence);
      }
      this.update({
        retentionGap,
        ...(pauseVersion === this.pauseVersion ? { paused: latest.paused } : {}),
      });
      applied = true;
    } catch {
      if (epoch === this.epoch) this.update({ error: 'Unable to load chat. Try again.' });
    } finally {
      if (epoch === this.epoch) {
        this.update({ loading: false });
        if (applied) this.flush();
      }
    }
  }

  private flush(): void {
    if (this.appliedThrough === null) return;
    const contiguous: ChatMessage[] = [];
    while (this.buffered.has(this.appliedThrough + 1)) {
      this.appliedThrough += 1;
      contiguous.push(this.buffered.get(this.appliedThrough)!);
      this.buffered.delete(this.appliedThrough);
    }
    if (contiguous.length) this.merge(contiguous);
    if (this.buffered.size && this.lastGap !== this.appliedThrough) {
      this.lastGap = this.appliedThrough;
      void this.refresh();
    }
  }

  private merge(incoming: ChatMessage[]): void {
    const bySequence = new Map(this.state.messages.map((message) => [message.sequence, message]));
    for (const message of incoming) bySequence.set(message.sequence, message);
    this.update({
      messages: [...bySequence.values()]
        .sort((a, b) => a.sequence - b.sequence)
        .slice(-CHAT_MESSAGE_RETENTION),
    });
  }

  private pendingCount(): number {
    return this.state.attempts.filter((item) => item.status === 'pending').length;
  }

  private async send(request: ChatSendRequest): Promise<void> {
    const transport = this.transport;
    if (!transport) return;
    const epoch = this.epoch;
    this.update({
      error: '',
      attempts: [
        ...this.state.attempts.filter((item) => item.requestId !== request.requestId),
        { ...request, status: 'pending', error: '' },
      ],
    });
    try {
      const ack = await transport.chatSend(request);
      if (epoch !== this.epoch) return;
      if (ack.ok) {
        this.receive(ack.message);
        this.dismissAttempt(request.requestId);
      } else {
        if (ack.error === 'chat_paused') this.receivePaused(true);
        this.failAttempt(request.requestId, ack.message);
      }
    } catch {
      if (epoch === this.epoch) this.failAttempt(request.requestId, UNSENT);
    }
  }

  private dismissAttempt(requestId: string): void {
    this.update({ attempts: this.state.attempts.filter((item) => item.requestId !== requestId) });
  }
  private failAttempt(requestId: string, error: string): void {
    this.update({
      attempts: this.state.attempts.map((item) =>
        item.requestId === requestId ? { ...item, status: 'failed', error } : item,
      ),
    });
  }
  private invalidate(): void {
    this.epoch += 1;
    this.transport = null;
    this.lastGap = null;
    this.update({
      loading: false,
      pausePending: false,
      attempts: this.state.attempts.map((item) =>
        item.status === 'pending' ? { ...item, status: 'failed', error: UNSENT } : item,
      ),
    });
  }
  private update(patch: Partial<ChatState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
}
