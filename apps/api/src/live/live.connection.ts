import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { env } from '../config/env';

// Connection commands only. quit() is intentionally absent so shutdown cannot wait on a dead server.
export interface LiveRedisClient {
  status: string;
  connect(): Promise<void>;
  ping(): Promise<string>;
  scan(
    cursor: string,
    match: 'MATCH',
    pattern: string,
    count: 'COUNT',
    countValue: number,
  ): Promise<[string, string[]]>;
  del(...keys: string[]): Promise<number>;
  set(key: string, value: string, condition: 'NX'): Promise<'OK' | null>;
  eval(script: string, count: number, key: string, token: string): Promise<unknown>;
  disconnect(): void;
  on(event: 'error' | 'close' | 'end', listener: (error?: Error) => void): void;
}

export const liveResetExitBoundMs = 1000;

function createRedis(): LiveRedisClient {
  return new Redis(env.REDIS_URL, {
    lazyConnect: true,
    connectTimeout: 3000,
    commandTimeout: 3000,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
  });
}

@Injectable()
export class LiveConnection implements OnModuleInit, OnModuleDestroy, OnApplicationShutdown {
  private readonly logger = new Logger(LiveConnection.name);
  private readonly redis: LiveRedisClient;
  // The repository needs the ioredis instance used in production. Tests pass a fake client.
  readonly client: Redis;
  private readonly listeners = new Set<() => void>();
  private ready = false;
  private lost = false;
  private closing = false;
  private disconnected = false;
  private owned = false;
  private readonly ownerToken = `${process.pid}:${randomUUID()}`;

  constructor(
    redis?: LiveRedisClient,
    private readonly namespace = env.LIVE_NAMESPACE,
  ) {
    this.redis = redis ?? createRedis();
    this.client = this.redis as unknown as Redis;
    this.redis.on('error', (error) => {
      this.logger.error(`Redis: ${error?.message ?? 'unknown failure'}`);
    });
    // Connection close is the dependency-loss signal. A rejected command leaves the socket up.
    this.redis.on('close', () => this.lose(new Error('Redis connection closed.')));
    this.redis.on('end', () => this.lose(new Error('Redis connection ended.')));
  }

  async onModuleInit(): Promise<void> {
    await this.open();
  }

  onModuleDestroy(): void {
    this.ready = false;
    this.closing = true;
  }

  async onApplicationShutdown(): Promise<void> {
    try {
      if (this.owned && this.redis.status === 'ready') {
        await this.redis.eval(
          "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0",
          1,
          `${this.namespace}:owner`,
          this.ownerToken,
        );
      }
    } finally {
      this.close();
    }
  }

  isReady(): boolean {
    return this.ready;
  }

  whenLost(listener: () => void): void {
    this.listeners.add(listener);
    if (this.lost) this.call(listener);
  }

  async open(): Promise<void> {
    try {
      await this.redis.connect();
      await this.redis.ping();
      if ((await this.redis.set(`${this.namespace}:owner`, this.ownerToken, 'NX')) !== 'OK')
        throw new Error(
          `Live namespace ${this.namespace} already has an API owner; no presence was cleared.`,
        );
      this.owned = true;
      await this.clearPresence();
      this.ready = true;
    } catch (error) {
      this.closing = true;
      this.ready = false;
      this.close();
      throw new Error(
        `Redis startup failed; the API will not listen. ${error instanceof Error ? error.message : ''}`,
        { cause: error },
      );
    }
  }

  // Local teardown. Disconnect does not wait for Redis, and it must not look like a runtime loss.
  close(): void {
    if (this.disconnected) return;
    this.disconnected = true;
    this.closing = true;
    this.ready = false;
    this.redis.disconnect();
  }

  private async clearPresence(): Promise<void> {
    let cursor = '0';
    do {
      const [next, keys] = await this.redis.scan(
        cursor,
        'MATCH',
        `${this.namespace}:room:*`,
        'COUNT',
        100,
      );
      cursor = next;
      if (keys.length) await this.redis.del(...keys);
    } while (cursor !== '0');
  }

  private lose(error: Error): void {
    if (this.closing || this.lost || !this.ready) return;
    this.lost = true;
    this.ready = false;
    this.logger.error(`Redis lost; resetting live sessions without resume: ${error.message}`);
    for (const listener of this.listeners) this.call(listener);
  }

  private call(listener: () => void): void {
    try {
      listener();
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : 'unknown failure';
      this.logger.error(`Live reset listener failed: ${detail}`);
    }
  }
}

// Schedule process exit after sockets have been dropped. PostgreSQL failures must not call this.
export function bindLiveResetExit(
  connection: Pick<LiveConnection, 'whenLost'>,
  exit: (code: number) => void,
  boundMs = liveResetExitBoundMs,
): void {
  connection.whenLost(() => {
    const timer = setTimeout(() => exit(1), boundMs);
    timer.unref();
  });
}
