import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Repository, EntityManager } from 'typeorm';
import { randomUUID, createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import type { User } from '../users/user.entity';
import { env } from '../config/env';
import { GoogleController } from './google.controller';
import { SessionsService } from './sessions.service';
import {
  GOOGLE_STATE,
  GOOGLE_EXCHANGE,
  GOOGLE_CONFIG,
  type GoogleState,
  type GoogleStateStore,
} from './google-state';
import { ApiExceptionFilter } from '../http/api-exception.filter';
import { googleRejected } from './google-exchange';
import type { GuestSessionResponse } from '@stageflow/shared';

afterEach(() => vi.restoreAllMocks());
async function fixture(
  enabled: boolean,
  test: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>,
) {
  const previous = env.GOOGLE_ENABLED;
  env.GOOGLE_ENABLED = enabled;
  const f = await setup(enabled);
  try {
    await test(f);
  } finally {
    await f.app.close();
    env.GOOGLE_ENABLED = previous;
  }
}
async function setup(enabled = true) {
  const host = {
    id: randomUUID(),
    displayName: 'Ava',
    email: 'ava@example.com',
    passwordHash: 'hash',
    sessionVersion: 0,
    isGuest: false,
    googleSubject: null,
  } as User;
  const guest = { ...host, id: randomUUID(), email: null, isGuest: true } as User;
  const rows = [host, guest];
  let selectedId = host.id;
  const users = {
    findOneBy: vi.fn(
      async (fields: Partial<User>) =>
        rows.find((row) => Object.entries(fields).every(([k, v]) => row[k as keyof User] === v)) ??
        null,
    ),
    create: (fields: Partial<User>) => ({ id: randomUUID(), ...fields }) as User,
    save: vi.fn(async (user: User) => {
      rows.push(user);
      return user;
    }),
    update: vi.fn(async (id: string, fields: Partial<User>) => {
      Object.assign(
        rows.find((row) => row.id === id)!,
        fields,
      );
    }),
    createQueryBuilder: () => ({
      addSelect() {
        return this;
      },
      where(_sql: string, fields: { id: string }) {
        selectedId = fields.id;
        return this;
      },
      setLock() {
        return this;
      },
      getOne: async () => rows.find((row) => row.id === selectedId),
    }),
    manager: {
      transaction: async (work: (m: EntityManager) => Promise<User>) =>
        work({ getRepository: () => users } as unknown as EntityManager),
    },
  };
  const jwt = new JwtService({ secret: randomUUID() });
  const sessions = new SessionsService(users as unknown as Repository<User>, jwt);
  const states = new Map<string, GoogleState>();
  const tickets = new Map<string, GuestSessionResponse>();
  const store: GoogleStateStore = {
    async putState(k, v) {
      states.set(k, v);
    },
    async takeState(k) {
      const value = states.get(k) ?? null;
      states.delete(k);
      return value;
    },
    async putTicket(k, v) {
      tickets.set(k, v);
    },
    async takeTicket(k) {
      const value = tickets.get(k) ?? null;
      tickets.delete(k);
      return value;
    },
  };
  const exchange = vi.fn<
    (
      code: string,
      verifier: string,
    ) => Promise<{ subject: string; name: string; email: string | null }>
  >(async () => ({
    subject: 'new-subject',
    name: 'Google host',
    email: host.email,
  }));
  const config = {
    GOOGLE_ENABLED: enabled,
    GOOGLE_CLIENT_ID: 'client-id',
    GOOGLE_CLIENT_SECRET: 'test-secret',
    GOOGLE_REDIRECT_URI: 'http://localhost/api/sessions/google/callback',
    CORS_ORIGIN: 'http://web.test',
  };
  class TestModule {}
  Module({
    controllers: [GoogleController],
    providers: [
      { provide: SessionsService, useValue: sessions },
      { provide: GOOGLE_STATE, useValue: store },
      { provide: GOOGLE_EXCHANGE, useValue: exchange },
      { provide: GOOGLE_CONFIG, useValue: config },
    ],
  })(TestModule);
  const app = await NestFactory.create<NestExpressApplication>(TestModule, {
    logger: false,
    abortOnError: false,
  });
  app.setGlobalPrefix('api');
  app.useGlobalFilters(new ApiExceptionFilter());
  await app.listen(0, '127.0.0.1');
  const base = (await app.getUrl()) + '/api/sessions/google';
  const request = (path: string, init: RequestInit = {}) =>
    fetch(base + path, { redirect: 'manual', ...init });
  const post = (path: string, body: unknown, token?: string) =>
    request(path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
  const hostToken = await jwt.signAsync({ sub: host.id, sv: 0, guest: false });
  const guestToken = await jwt.signAsync({ sub: guest.id, sv: 0, guest: true });
  return {
    app,
    request,
    post,
    states,
    tickets,
    exchange,
    config,
    host,
    guest,
    rows,
    users,
    sessions,
    jwt,
    hostToken,
    guestToken,
  };
}
it('disables all action routes before authentication, state access or exchange', async () =>
  fixture(false, async (f) => {
    expect(await (await f.request('')).json()).toEqual({ enabled: false });
    for (const path of ['/start', '/callback']) {
      const r = await f.request(path);
      expect(r.status).toBe(404);
      expect(await r.json()).toMatchObject({ error: 'google_unavailable' });
    }
    for (const path of ['/ticket', '/link']) {
      const r = await f.post(path, {});
      expect(r.status).toBe(404);
      expect(await r.json()).toMatchObject({ error: 'google_unavailable' });
    }
    await expect(
      f.sessions.exchangeGoogleCode('code', 'verifier', f.exchange),
    ).rejects.toMatchObject({ response: { error: 'google_unavailable' } });
    expect(f.exchange).not.toHaveBeenCalled();
    expect(f.states.size).toBe(0);
  }));
it('uses PKCE and one-time state/ticket, creates a separate host despite equal email', async () =>
  fixture(true, async (f) => {
    expect(await (await f.request('')).json()).toEqual({ enabled: true });
    const start = await f.request('/start');
    expect(start.status).toBe(302);
    const auth = new URL(start.headers.get('location')!);
    expect(auth.hostname).toBe('accounts.google.com');
    expect(auth.searchParams.get('scope')).toBe('openid profile');
    expect(auth.searchParams.get('response_type')).toBe('code');
    expect(auth.searchParams.get('code_challenge_method')).toBe('S256');
    const state = auth.searchParams.get('state')!;
    const verifier = f.states.get(state)!.verifier;
    expect(auth.searchParams.get('code_challenge')).toBe(
      createHash('sha256').update(verifier).digest('base64url'),
    );
    expect(auth.href).not.toContain(f.config.GOOGLE_CLIENT_SECRET);
    expect(auth.href).not.toContain(verifier);
    const callback = await f.request(
      `/callback?state=${state}&code=auth-code&returnUrl=https://evil.test`,
    );
    const target = new URL(callback.headers.get('location')!);
    expect(target.origin + target.pathname).toBe('http://web.test/auth/google');
    expect(f.exchange).toHaveBeenCalledExactlyOnceWith('auth-code', verifier);
    expect(f.states.size).toBe(0);
    const ticket = target.searchParams.get('ticket')!;
    const redeemed = await f.post('/ticket', { ticket });
    expect(redeemed.status).toBe(201);
    const session = (await redeemed.json()) as GuestSessionResponse;
    expect(session.userId).not.toBe(f.host.id);
    expect(f.rows[2]).toMatchObject({
      email: null,
      passwordHash: null,
      isGuest: false,
      googleSubject: 'new-subject',
    });
    expect(f.host.email).toBe('ava@example.com');
    expect((await f.post('/ticket', { ticket })).status).toBe(401);
    const replay = await f.request(`/callback?state=${state}&code=auth-code`);
    expect(replay.headers.get('location')).toBe(
      'http://web.test/auth/google?error=google_rejected',
    );
    expect(f.exchange).toHaveBeenCalledTimes(1);
  }));
it('requires a host for linking, preserves credentials, and redirects link conflicts', async () =>
  fixture(true, async (f) => {
    expect((await f.post('/link', {})).status).toBe(401);
    const guest = await f.post('/link', {}, f.guestToken);
    expect(guest.status).toBe(403);
    expect(await guest.json()).toMatchObject({ error: 'google_host_required' });
    const before = { ...f.host };
    const link = await f.post('/link', {}, f.hostToken);
    const auth = new URL(((await link.json()) as { url: string }).url);
    const state = auth.searchParams.get('state')!;
    expect(f.states.get(state)).toMatchObject({ kind: 'link', userId: f.host.id });
    const callback = await f.request(`/callback?state=${state}&code=code`);
    expect(callback.headers.get('location')).toBe('http://web.test/auth/google?linked=1');
    expect(f.host).toEqual({ ...before, googleSubject: 'new-subject' });
    expect(f.tickets.size).toBe(0);
    f.rows.push({ ...f.host, id: randomUUID(), googleSubject: 'owned' });
    f.exchange.mockResolvedValue({ subject: 'owned', name: 'Conflict', email: null });
    const retry = await f.post('/link', {}, f.hostToken);
    const retryState = new URL(((await retry.json()) as { url: string }).url).searchParams.get(
      'state',
    );
    const conflict = await f.request(`/callback?state=${retryState}&code=code`);
    expect(conflict.headers.get('location')).toBe(
      'http://web.test/auth/google?error=google_linked',
    );
    expect(f.host.googleSubject).toBe('new-subject');
  }));
it('consumes rejected state and sanitizes exchange failures', async () =>
  fixture(true, async (f) => {
    const auth = new URL((await f.request('/start')).headers.get('location')!);
    const state = auth.searchParams.get('state')!;
    f.exchange.mockRejectedValue(googleRejected());
    const result = await f.request(`/callback?state=${state}&code=code`);
    expect(result.headers.get('location')).toBe(
      'http://web.test/auth/google?error=google_rejected',
    );
    expect(f.states.size).toBe(0);
    expect(f.users.save).not.toHaveBeenCalled();
    expect((await f.post('/ticket', { ticket: 'invalid' })).status).toBe(401);
  }));
it('shares the password in-flight cap and releases slots after failure', async () =>
  fixture(true, async (f) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.exchange.mockImplementation(async () => {
      await gate;
      throw googleRejected();
    });
    const active = Promise.allSettled(
      Array.from({ length: env.GUEST_PENDING_LIMIT }, () =>
        f.sessions.exchangeGoogleCode('code', 'verifier', f.exchange),
      ),
    );
    await vi.waitFor(() => expect(f.exchange).toHaveBeenCalledTimes(env.GUEST_PENDING_LIMIT));
    await expect(
      f.sessions.exchangeGoogleCode('excess', 'verifier', f.exchange),
    ).rejects.toMatchObject({ response: { error: 'server_busy' } });
    await expect(f.sessions.login('ava@example.com', 'password')).rejects.toMatchObject({
      response: { error: 'server_busy' },
    });
    const auth = new URL((await f.request('/start')).headers.get('location')!);
    const callback = await f.request(
      `/callback?state=${auth.searchParams.get('state')}&code=excess`,
    );
    expect(callback.status).toBe(503);
    expect(await callback.json()).toMatchObject({ error: 'server_busy' });
    expect(f.exchange).toHaveBeenCalledTimes(env.GUEST_PENDING_LIMIT);
    release();
    await active;
    f.exchange.mockResolvedValue({ subject: 'after', name: 'After', email: null });
    await expect(
      f.sessions.exchangeGoogleCode('code', 'verifier', f.exchange),
    ).resolves.toMatchObject({ displayName: 'After' });
  }));
