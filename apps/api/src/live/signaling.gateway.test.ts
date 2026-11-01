import { expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { LiveConnection, type LiveRedisClient } from './live.connection';
import { SignalingGateway } from './signaling.gateway';
import type { LiveService } from './live.service';
import type { SessionsService } from '../sessions/sessions.service';

class ClosingRedis {
  status = 'wait';
  private closeListener: (() => void) | undefined;

  async connect(): Promise<void> {
    this.status = 'ready';
  }

  async ping(): Promise<string> {
    return 'PONG';
  }

  async scan(): Promise<[string, string[]]> {
    return ['0', []];
  }

  async del(): Promise<number> {
    return 0;
  }

  disconnect(): void {
    this.status = 'end';
  }

  on(event: 'error' | 'close' | 'end', listener: (error?: Error) => void): void {
    if (event === 'close') this.closeListener = () => listener();
  }

  close(): void {
    this.status = 'end';
    this.closeListener?.();
  }
}

it('drops sockets on Redis loss without trying to end catalog rooms', async () => {
  const logger = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  try {
    const redis = new ClosingRedis();
    const connection = new LiveConnection(redis as unknown as LiveRedisClient);
    await connection.open();
    const leave = vi.fn();
    const gateway = new SignalingGateway(
      { verifyToken: vi.fn() } as unknown as SessionsService,
      { leave } as unknown as LiveService,
      connection,
    );
    const disconnectSockets = vi.fn((close?: boolean) => {
      expect(close).toBe(true);
      gateway.handleDisconnect({ id: 'host' } as never);
    });
    gateway.afterInit({
      use: () => undefined,
      disconnectSockets,
    } as never);
    redis.close();
    expect(disconnectSockets).toHaveBeenCalledTimes(1);
    expect(leave).not.toHaveBeenCalled();
    expect(connection.isReady()).toBe(false);
  } finally {
    logger.mockRestore();
  }
});
