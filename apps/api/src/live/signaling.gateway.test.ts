import { expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { LiveConnection, type LiveRedisClient } from './live.connection';
import { SignalingGateway } from './signaling.gateway';
import type { LiveService } from './live.service';
import type { SessionsService } from '../sessions/sessions.service';
import { env } from '../config/env';
import { isUuid } from '@stageflow/shared';
import { createHash } from 'node:crypto';
import type { ChatService } from '../chat/chat.service';

it('issues a membership UUID and uses it for later commands instead of the socket id', async () => {
  const join = vi.fn<LiveService['join']>(async (session, _request, _transport, participantId) => {
    session.participantId = participantId;
    session.room = { roomId: 'room', hostId: 'host', mode: 'MEETING', status: 'LIVE' };
    return { ok: true };
  });
  const update = vi.fn<LiveService['update']>(async () => ({ ok: true }));
  const gateway = new SignalingGateway(
    {} as SessionsService,
    { join, update } as unknown as LiveService,
    {} as LiveConnection,
    {} as ChatService,
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

it.each(['host', 'waiter'])(
  'does not return a resume credential to a scheduled %s',
  async (userId) => {
    const join = vi.fn<LiveService['join']>(async (session, request, _transport, participantId) => {
      session.participantId = participantId;
      session.room = {
        roomId: request.roomId,
        hostId: 'host',
        mode: 'MEETING',
        status: 'SCHEDULED',
      };
      return { ok: true };
    });
    const gateway = new SignalingGateway(
      {} as SessionsService,
      { join } as unknown as LiveService,
      {} as LiveConnection,
      {} as ChatService,
    );
    const client = { id: `socket-${userId}`, connected: true, data: { user: { id: userId } } };
    const ack = await gateway.join(client as never, {
      roomId: '01234567-89ab-cdef-0123-456789abcdef',
      isAudioMuted: false,
      isVideoOff: false,
      isSyntheticBot: false,
    });
    expect(ack.ok).toBe(true);
    expect(ack).not.toHaveProperty('resumeCredential');
    expect(client.data).not.toHaveProperty('joinCredential');
  },
);

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
    {} as ChatService,
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
      {} as ChatService,
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
    {} as ChatService,
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

it('strictly parses chat payloads and uses only the socket-bound membership and room', async () => {
  const message = {
    sequence: 1,
    participantId: 'member',
    displayName: 'Ava',
    role: 'HOST',
    text: 'Hello',
    sentAt: 1000,
  } as const;
  const history = {
    paused: false,
    oldestSequence: 1,
    latestSequence: 1,
    retentionGap: false,
    messages: [message],
  };
  const send = vi.fn<ChatService['send']>(async (session, _request, transport) => {
    transport.message(session.room!.roomId, message);
    return { ok: true, message };
  });
  const readHistory = vi.fn<ChatService['history']>(async () => ({ ok: true, ...history }));
  const setPaused = vi.fn<ChatService['setPaused']>(async (session, paused, transport) => {
    transport.paused(session.room!.roomId, { paused });
    return { ok: true, paused };
  });
  const gateway = new SignalingGateway(
    {} as SessionsService,
    {} as LiveService,
    {} as LiveConnection,
    { send, history: readHistory, setPaused } as unknown as ChatService,
  );
  const emit = vi.fn();
  const to = vi.fn(() => ({ emit }));
  gateway.server = { to } as never;
  const client = {
    id: 'socket',
    connected: true,
    data: {
      user: { id: 'guest', displayName: 'Guest' },
      participantId: 'member',
      generation: 2,
      room: { roomId: 'bound-room', hostId: 'guest', mode: 'WEBINAR', status: 'LIVE' },
    },
  };
  const requestId = '550e8400-e29b-41d4-a716-446655440000';
  const request = { requestId, text: ' \nHello\t ' };
  for (const field of ['roomId', 'displayName', 'role', 'sequence', 'sentAt'])
    expect(
      await gateway.sendChat(client as never, { ...request, [field]: 'forged' }),
    ).toMatchObject({ error: 'invalid_payload' });
  expect(await gateway.sendChat(client as never, { requestId, text: ' ' })).toMatchObject({
    error: 'chat_invalid',
  });
  expect(send).not.toHaveBeenCalled();
  expect(await gateway.sendChat(client as never, request)).toEqual({ ok: true, message });
  expect(send.mock.calls[0]![0]).toMatchObject({
    id: 'socket',
    participantId: 'member',
    generation: 2,
    room: client.data.room,
  });
  expect(send.mock.calls[0]![1]).toEqual({ requestId, text: 'Hello' });
  expect(to).toHaveBeenCalledExactlyOnceWith('bound-room');
  expect(emit).toHaveBeenCalledExactlyOnceWith('chat:message', message);
  expect(await gateway.chatHistory(client as never, undefined)).toEqual({ ok: true, ...history });
  expect(readHistory.mock.calls[0]![1]).toEqual({ limit: 50 });
  expect(await gateway.chatHistory(client as never, { limit: 101 })).toMatchObject({
    error: 'invalid_payload',
  });
  expect(
    await gateway.setChatPaused(client as never, { paused: true, role: 'HOST' }),
  ).toMatchObject({ error: 'invalid_payload' });
  expect(await gateway.setChatPaused(client as never, { paused: true })).toEqual({
    ok: true,
    paused: true,
  });
  expect(emit).toHaveBeenLastCalledWith('chat:paused', { paused: true });
  expect(emit).not.toHaveBeenCalledWith('room:state', expect.anything());
});

it('charges all chat events to the socket event budget and preserves the leave bypass', () => {
  const gateway = new SignalingGateway(
    {} as SessionsService,
    {} as LiveService,
    {} as LiveConnection,
    {} as ChatService,
  );
  let middleware!: (packet: unknown[], next: () => void) => void;
  gateway.handleConnection({
    data: { user: { id: 'budget-user' } },
    use: (handler: typeof middleware) => {
      middleware = handler;
    },
  } as never);
  for (let index = 0; index < env.SOCKET_EVENT_RATE_LIMIT; index++) {
    const next = vi.fn();
    middleware(['chat:send', {}, vi.fn()], next);
    expect(next).toHaveBeenCalledOnce();
  }
  for (const event of ['chat:send', 'chat:history', 'chat:set-paused']) {
    const ack = vi.fn(),
      next = vi.fn();
    middleware([event, {}, ack], next);
    expect(next).not.toHaveBeenCalled();
    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ error: 'rate_limited' }));
  }
  const leave = vi.fn();
  middleware(['room:leave', vi.fn()], leave);
  expect(leave).toHaveBeenCalledOnce();
});

it('routes schedule commands through the host membership and validates waiter targets', async () => {
  const scheduleCommand = vi.fn<LiveService['scheduleCommand']>(async () => ({ ok: true }));
  const update = vi.fn<LiveService['update']>(async () => ({ ok: true }));
  const gateway = new SignalingGateway(
    {} as SessionsService,
    { scheduleCommand, update } as unknown as LiveService,
    {} as LiveConnection,
    {} as ChatService,
  );
  const client = {
    id: 'socket',
    connected: true,
    data: { user: { id: 'host' }, participantId: 'membership' },
  };
  await gateway.startRoom(client as never);
  await gateway.cancelRoom(client as never);
  expect(scheduleCommand.mock.calls.map((call) => call[1])).toEqual(['start', 'cancel']);
  const targetParticipantId = '11111111-1111-4111-8111-111111111111';
  expect(
    gateway.admit(client as never, { targetParticipantId, actorParticipantId: 'forged' }),
  ).toMatchObject({ error: 'invalid_payload' });
  await gateway.admit(client as never, { targetParticipantId });
  await gateway.removeWaiter(client as never, { targetParticipantId });
  expect(update.mock.calls.map((call) => call[1])).toEqual([
    { type: 'admit', actorParticipantId: 'membership', targetParticipantId },
    { type: 'removeWaiter', actorParticipantId: 'membership', targetParticipantId },
  ]);
  expect(gateway.admit(client as never, { targetParticipantId: '' })).toMatchObject({
    error: 'invalid_payload',
  });
  expect(gateway.removeWaiter(client as never, null)).toMatchObject({ error: 'invalid_payload' });
  expect(update).toHaveBeenCalledTimes(2);
});
