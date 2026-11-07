import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Redis } from 'ioredis';
import type { QaState, QaSubmitRequest, TransportBinding } from '@stageflow/shared';

export type QaStoreError =
  | 'stale_transport'
  | 'not_host'
  | 'qa_not_allowed'
  | 'qa_closed'
  | 'qa_full'
  | 'qa_rate_limited'
  | 'qa_vote_rate_limited'
  | 'qa_missing'
  | 'qa_busy';
export type QaStoreState = QaState & { votedQuestionIds: string[] };
export type QaStoreResult = { ok: true; value: QaStoreState } | { ok: false; error: QaStoreError };
export type QaLimits = {
  boardMax: number;
  ttlSeconds: number;
  submitParticipantLimit: number;
  submitRoomLimit: number;
  voteParticipantLimit: number;
  voteRoomLimit: number;
  rateWindowMs: number;
  userRateMaxFields: number;
};

export function qaKeys(prefix: string): string[] {
  return [
    'seq',
    'questions',
    'featured',
    'submissions',
    'submit-room-rate',
    'submit-user-rate',
    'vote-room-rate',
    'vote-user-rate',
  ].map((suffix) => `${prefix}:qa:${suffix}`);
}

const scriptNames = [
  'submit',
  'vote',
  'state',
  'delete',
  'dismiss',
  'feature',
  'clear-feature',
  'set-submissions',
] as const;
type ScriptName = (typeof scriptNames)[number];

export class QaRepository {
  private readonly scripts: Record<ScriptName, { source: string; sha: string }>;

  constructor(private readonly redis: Redis) {
    const directory = join(__dirname, 'scripts');
    const common = readFileSync(join(directory, 'common.lua'), 'utf8');
    this.scripts = Object.fromEntries(
      scriptNames.map((name) => {
        const body = readFileSync(join(directory, `${name}.lua`), 'utf8');
        // Room cleanup has no transport binding and remains independent of authorization.
        const source = name === 'delete' ? body : `${common}\n${body}`;
        return [name, { source, sha: createHash('sha1').update(source).digest('hex') }];
      }),
    ) as Record<ScriptName, { source: string; sha: string }>;
  }

  submit(
    prefix: string,
    binding: TransportBinding,
    request: QaSubmitRequest,
    limits: QaLimits,
    now: number,
  ): Promise<QaStoreResult> {
    // Identity fields, even from an internal caller, never override the membership row.
    return this.execute('submit', prefix, { binding, text: request.text, ...limits, now });
  }

  vote(
    prefix: string,
    binding: TransportBinding,
    questionId: string,
    limits: QaLimits,
    now: number,
  ): Promise<QaStoreResult> {
    return this.execute('vote', prefix, { binding, questionId, ...limits, now });
  }

  state(prefix: string, binding: TransportBinding): Promise<QaStoreResult> {
    return this.execute('state', prefix, { binding });
  }

  dismiss(
    prefix: string,
    binding: TransportBinding,
    questionId: string,
    ttlSeconds: number,
  ): Promise<QaStoreResult> {
    return this.execute('dismiss', prefix, { binding, questionId, ttlSeconds });
  }

  feature(
    prefix: string,
    binding: TransportBinding,
    questionId: string,
    ttlSeconds: number,
  ): Promise<QaStoreResult> {
    return this.execute('feature', prefix, { binding, questionId, ttlSeconds });
  }

  clearFeature(
    prefix: string,
    binding: TransportBinding,
    ttlSeconds: number,
  ): Promise<QaStoreResult> {
    return this.execute('clear-feature', prefix, { binding, ttlSeconds });
  }

  setSubmissions(
    prefix: string,
    binding: TransportBinding,
    open: boolean,
    ttlSeconds: number,
  ): Promise<QaStoreResult> {
    return this.execute('set-submissions', prefix, { binding, open, ttlSeconds });
  }

  async delete(prefix: string): Promise<void> {
    await this.execute('delete', prefix, {});
  }

  private async execute<T>(name: ScriptName, prefix: string, body: object): Promise<T> {
    const script = this.scripts[name];
    const keys = [...qaKeys(prefix), `${prefix}:participants`];
    let result: unknown;
    try {
      result = await this.redis.evalsha(script.sha, keys.length, ...keys, JSON.stringify(body));
    } catch (error) {
      // Only NOSCRIPT proves the mutation did not run. Do not replay ambiguous failures.
      if (!(error instanceof Error) || !/^NOSCRIPT\b/.test(error.message)) throw error;
      result = await this.redis.eval(script.source, keys.length, ...keys, JSON.stringify(body));
    }
    if (typeof result !== 'string') throw new Error('Invalid Redis question result.');
    return JSON.parse(result) as T;
  }
}
