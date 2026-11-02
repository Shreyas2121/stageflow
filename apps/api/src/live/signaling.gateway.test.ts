import { expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { LiveConnection, type LiveRedisClient } from './live.connection';
import { SignalingGateway } from './signaling.gateway';
import type { LiveService } from './live.service';
import type { SessionsService } from '../sessions/sessions.service';
import { env } from '../config/env';

class ClosingRedis {
  status = 'wait';
  async set(): Promise<'OK'> {
    return 'OK';
  }
  async eval(): Promise<number> {
    return 1;
  }
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

it('bounds concurrent authentication before starting additional user lookups', async () => {
  let release!: (user: { id: string }) => void;
  const gate = new Promise<{ id: string }>((resolve) => {
    release = resolve;
  });
  const verifyToken = vi.fn(() => gate);
  const gateway = new SignalingGateway(
    { verifyToken } as unknown as SessionsService,
    {} as LiveService,
    { whenLost: () => {} } as unknown as LiveConnection,
  );
  let middleware!: (socket: unknown, next: (error?: Error) => void) => void;
  gateway.afterInit({
    use: (handler: typeof middleware) => {
      middleware = handler;
    },
  } as never);
  const callbacks = Array.from({ length: env.AUTH_PENDING_LIMIT }, () => vi.fn());
  for (const [index, next] of callbacks.entries())
    middleware(
      {
        handshake: { auth: { token: 'token' } },
        request: { socket: { remoteAddress: `10.0.0.${index + 1}` }, headers: {} },
        data: {},
      },
      next,
    );
  const excess = vi.fn();
  middleware({ request: { socket: { remoteAddress: '10.0.1.1' }, headers: {} } }, excess);
  expect(excess).toHaveBeenCalledWith(expect.any(Error));
  expect(verifyToken).toHaveBeenCalledTimes(env.AUTH_PENDING_LIMIT);
  release({ id: 'user' });
  await vi.waitFor(() =>
    expect(callbacks.every((next) => next.mock.calls.length === 1)).toBe(true),
  );
});
