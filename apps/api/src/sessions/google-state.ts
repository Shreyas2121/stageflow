import { Redis } from 'ioredis';
import type { OnModuleDestroy } from '@nestjs/common';
import type { GuestSessionResponse } from '@stageflow/shared';
import { env } from '../config/env';

export type GoogleState =
  { kind: 'sign-in'; verifier: string } | { kind: 'link'; userId: string; verifier: string };
export interface GoogleStateStore {
  putState(key: string, value: GoogleState): Promise<void>;
  takeState(key: string): Promise<GoogleState | null>;
  putTicket(key: string, value: GuestSessionResponse): Promise<void>;
  takeTicket(key: string): Promise<GuestSessionResponse | null>;
}
export const GOOGLE_STATE = Symbol('GOOGLE_STATE');
export const GOOGLE_EXCHANGE = Symbol('GOOGLE_EXCHANGE');
export const GOOGLE_CONFIG = Symbol('GOOGLE_CONFIG');

export class RedisGoogleState implements GoogleStateStore, OnModuleDestroy {
  constructor(
    private readonly redis = new Redis(env.REDIS_URL, {
      lazyConnect: true,
      connectTimeout: 3000,
      commandTimeout: 3000,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
    }),
    private readonly namespace = env.LIVE_NAMESPACE,
  ) {
    // Command failures are handled by the request; Redis error events contain connection details.
    this.redis.on('error', () => {});
  }
  async putState(key: string, value: GoogleState): Promise<void> {
    await this.redis.set(`${this.namespace}:google:state:${key}`, JSON.stringify(value), 'EX', 300);
  }
  async takeState(key: string): Promise<GoogleState | null> {
    const value = await this.redis.getdel(`${this.namespace}:google:state:${key}`);
    return value ? (JSON.parse(value) as GoogleState) : null;
  }
  async putTicket(key: string, value: GuestSessionResponse): Promise<void> {
    await this.redis.set(`${this.namespace}:google:ticket:${key}`, JSON.stringify(value), 'EX', 60);
  }
  async takeTicket(key: string): Promise<GuestSessionResponse | null> {
    const value = await this.redis.getdel(`${this.namespace}:google:ticket:${key}`);
    return value ? (JSON.parse(value) as GuestSessionResponse) : null;
  }
  async onModuleDestroy(): Promise<void> {
    if (this.redis.status === 'wait' || this.redis.status === 'end') this.redis.disconnect();
    else {
      try {
        await this.redis.quit();
      } finally {
        this.redis.disconnect();
      }
    }
  }
}
