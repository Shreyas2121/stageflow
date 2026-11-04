import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Redis } from 'ioredis';
import type {
  ChatHistoryRequest,
  ChatHistoryResult,
  ChatMessage,
  ChatSendRequest,
  TransportBinding,
} from '@stageflow/shared';

export type ChatStoreError =
  'stale_transport' | 'not_host' | 'chat_paused' | 'chat_rate_limited' | 'chat_busy';
export type ChatStoreResult<T> = { ok: true; value: T } | { ok: false; error: ChatStoreError };
export type ChatAcceptLimits = {
  retention: number;
  dedupCapacity: number;
  ttlSeconds: number;
  participantRateLimit: number;
  roomRateLimit: number;
  rateWindowMs: number;
  userRateMaxFields: number;
};

export function chatKeys(prefix: string): string[] {
  return ['seq', 'messages', 'paused', 'dedup', 'room-rate', 'user-rate'].map(
    (suffix) => `${prefix}:chat:${suffix}`,
  );
}

const scriptNames = ['accept', 'history', 'setPaused'] as const;
type ScriptName = (typeof scriptNames)[number];

export class ChatRepository {
  private readonly scripts: Record<ScriptName, { source: string; sha: string }>;

  constructor(private readonly redis: Redis) {
    this.scripts = Object.fromEntries(
      scriptNames.map((name) => {
        const source = readFileSync(join(__dirname, 'scripts', `${name}.lua`), 'utf8');
        return [name, { source, sha: createHash('sha1').update(source).digest('hex') }];
      }),
    ) as Record<ScriptName, { source: string; sha: string }>;
  }

  accept(
    prefix: string,
    binding: TransportBinding,
    request: ChatSendRequest,
    limits: ChatAcceptLimits,
    now: number,
  ): Promise<ChatStoreResult<ChatMessage>> {
    return this.execute('accept', prefix, { binding, ...request, ...limits, now });
  }

  history(
    prefix: string,
    binding: TransportBinding,
    request: ChatHistoryRequest & { limit: number },
  ): Promise<ChatStoreResult<ChatHistoryResult>> {
    return this.execute('history', prefix, { binding, ...request });
  }

  setPaused(
    prefix: string,
    binding: TransportBinding,
    paused: boolean,
    ttlSeconds: number,
  ): Promise<ChatStoreResult<{ paused: boolean }>> {
    return this.execute('setPaused', prefix, { binding, paused, ttlSeconds });
  }

  async delete(prefix: string): Promise<void> {
    await this.redis.del(...chatKeys(prefix));
  }

  private async execute<T>(
    name: ScriptName,
    prefix: string,
    body: object,
  ): Promise<ChatStoreResult<T>> {
    const script = this.scripts[name];
    const keys = [...chatKeys(prefix), `${prefix}:participants`];
    const args = [JSON.stringify(body)];
    let result: unknown;
    try {
      result = await this.redis.evalsha(script.sha, keys.length, ...keys, ...args);
    } catch (error) {
      // Only NOSCRIPT proves the mutation did not run. Never replay an ambiguous failure.
      if (!(error instanceof Error) || !/^NOSCRIPT\b/.test(error.message)) throw error;
      result = await this.redis.eval(script.source, keys.length, ...keys, ...args);
    }
    if (typeof result !== 'string') throw new Error('Invalid Redis chat result.');
    return JSON.parse(result) as ChatStoreResult<T>;
  }
}
