import { expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { LiveConnection, type LiveRedisClient } from './live.connection';
import { SignalingGateway } from './signaling.gateway';
import type { LiveService } from './live.service';
import type { SessionsService } from '../sessions/sessions.service';
import { env } from '../config/env';
import { isUuid } from '@stageflow/shared';
import { createHash } from 'node:crypto';

it('issues a membership UUID and uses it for later commands instead of the socket id', async () => {
  const join = vi.fn<LiveService['join']>(async (session, _request, _transport, participantId) => {
    session.participantId = participantId;
    return { ok: true };
  });
  const update = vi.fn<LiveService['update']>(async () => ({ ok: true }));
  const gateway = new SignalingGateway(
    {} as SessionsService,
    { join, update } as unknown as LiveService,
    {} as LiveConnection,
  );
  const client = {
    id: 'transport-id',
    connected: true,
    data: { user: { id: 'guest' }, participantId: undefined as string | undefined },
  };
  const ack = await gateway.join(client as never, {
    roomId: '01234567-89ab-cdef-0123-456789abcdef',
    isAudioMuted: true,
    isVideoOff: true,
    isSyntheticBot: false,
  });
  expect(ack.ok).toBe(true);
  if (!ack.ok) throw new Error(ack.error);
  expect(isUuid(ack.participantId)).toBe(true);
  expect(ack.participantId).not.toBe(client.id);
  expect(client.data.participantId).toBe(ack.participantId);
  expect(ack.resumeCredential).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(Buffer.from(ack.resumeCredential!, 'base64url')).toHaveLength(32);
  expect(join.mock.calls[0]![4]).toBe(
    createHash('sha256').update(ack.resumeCredential!).digest('hex'),
  );
  expect(client.data).not.toHaveProperty('joinCredential');
  await gateway.media(client as never, { isAudioMuted: true });
  expect(update).toHaveBeenCalledWith(
    expect.anything(),
    {
      type: 'patchMedia',
      participantId: ack.participantId,
      patch: { isAudioMuted: true },
    },
    expect.anything(),
  );
});

it('gives synthetic joins no resume credential and rejects an expired JWT before resume', async () => {
  const join = vi.fn<LiveService['join']>(async (session, _request, _transport, id) => {
    session.participantId = id;
    return { ok: true };
  });
  const resume = vi.fn();
  const verifyToken = vi.fn().mockRejectedValue(new Error('expired'));
  const gateway = new SignalingGateway(
    { verifyToken } as unknown as SessionsService,
    { join, resume } as unknown as LiveService,
    {} as LiveConnection,
  );
  const client = {
    id: 'bot-socket',
    connected: true,
    handshake: { auth: { token: 'expired' } },
    data: { user: { id: 'guest' } },
  };
  const roomId = '01234567-89ab-cdef-0123-456789abcdef';
  const ack = await gateway.join(client as never, {
    roomId,
    isAudioMuted: true,
    isVideoOff: true,
    isSyntheticBot: true,
  });
  expect(ack).not.toHaveProperty('resumeCredential');
  expect(join.mock.calls[0]![4]).toBeUndefined();
  expect(
    await gateway.resume(client as never, {
      roomId,
      participantId: roomId,
      resumeCredential: 'x'.repeat(43),
    }),
  ).toMatchObject({ error: 'invalid_resume' });
  expect(verifyToken).toHaveBeenCalledWith('expired');
  expect(resume).not.toHaveBeenCalled();
});

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
