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
  type GoogleTicket,
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
  const tickets = new Map<string, GoogleTicket>();
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
  const browser = () => {
    let cookie = '';
    const request = async (path: string, init: RequestInit = {}) => {
      const response = await fetch(base + path, {
        redirect: 'manual',
        ...init,
        headers: { Cookie: cookie, ...init.headers },
      });
      const setCookie = response.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0]!;
      return response;
    };
    const post = (path: string, body: unknown, token?: string) =>
      request(path, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      });
    return { request, post };
  };
  const { request, post } = browser();
  const hostToken = await jwt.signAsync({ sub: host.id, sv: 0, guest: false });
  const guestToken = await jwt.signAsync({ sub: guest.id, sv: 0, guest: true });
  return {
    app,
    request,
    post,
    browser,
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

function ticketFrom(response: Response): string {
  const url = new URL(response.headers.get('location')!);
  expect(url.searchParams.has('ticket')).toBe(false);
  return new URLSearchParams(url.hash.slice(1)).get('ticket')!;
}
async function begin(f: Awaited<ReturnType<typeof setup>>, token?: string) {
  const response = token ? await f.post('/link', {}, token) : await f.request('/start');
  const url = new URL(
    token ? ((await response.json()) as { url: string }).url : response.headers.get('location')!,
  );
  return { response, url, state: url.searchParams.get('state')! };
}
it('binds PKCE and one-time tickets to the browser, and never merges equal emails', async () =>
  fixture(true, async (f) => {
    const { response, url, state } = await begin(f);
    expect(response.headers.get('set-cookie')).toContain('HttpOnly');
    expect(response.headers.get('set-cookie')).toContain('SameSite=Lax');
    expect(response.headers.get('set-cookie')).toContain('Max-Age=300');
    const verifier = f.states.get(state)!.verifier;
    expect(url.searchParams.get('scope')).toBe('openid profile');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBe(
      createHash('sha256').update(verifier).digest('base64url'),
    );
    expect(url.href).not.toContain(f.config.GOOGLE_CLIENT_SECRET);
    expect(url.href).not.toContain(verifier);
    const callback = await f.request(
      '/callback?state=' + state + '&code=auth-code&returnUrl=https://evil.test',
    );
    expect(callback.headers.get('referrer-policy')).toBe('no-referrer');
    expect(f.exchange).not.toHaveBeenCalled();
    const ticket = ticketFrom(callback);
    const redeemed = await f.post('/ticket', { ticket });
    expect(redeemed.status).toBe(201);
    expect(redeemed.headers.get('cache-control')).toBe('no-store');
    expect(redeemed.headers.get('set-cookie')).toContain('Max-Age=0');
    const session = (await redeemed.json()) as GuestSessionResponse;
    expect(session.userId).not.toBe(f.host.id);
    expect(f.exchange).toHaveBeenCalledExactlyOnceWith('auth-code', verifier);
    expect(f.rows[2]).toMatchObject({
      email: null,
      passwordHash: null,
      isGuest: false,
      googleSubject: 'new-subject',
    });
    expect(f.host.googleSubject).toBeNull();
    expect((await f.post('/ticket', { ticket })).status).toBe(401);
    expect(
      (await f.request('/callback?state=' + state + '&code=auth-code')).headers.get('location'),
    ).toContain('error=google_rejected');
    expect(f.exchange).toHaveBeenCalledTimes(1);
  }));
it('requires the initiating host bearer at redemption, preserves credentials, and rejects duplicate subjects', async () =>
  fixture(true, async (f) => {
    expect((await f.post('/link', {})).status).toBe(401);
    expect((await f.post('/link', {}, f.guestToken)).status).toBe(403);
    const before = { ...f.host };
    const { state } = await begin(f, f.hostToken);
    const callback = await f.request('/callback?state=' + state + '&code=code');
    expect(f.host).toEqual(before);
    const result = await f.post('/ticket', { ticket: ticketFrom(callback) }, f.hostToken);
    expect(result.status).toBe(201);
    expect(await result.json()).toMatchObject({ userId: f.host.id });
    expect(f.host).toEqual({ ...before, googleSubject: 'new-subject' });
    f.rows.push({ ...f.host, id: randomUUID(), googleSubject: 'owned' });
    f.exchange.mockResolvedValue({ subject: 'owned', name: 'Conflict', email: null });
    const retry = await begin(f, f.hostToken);
    const conflict = await f.post(
      '/ticket',
      { ticket: ticketFrom(await f.request('/callback?state=' + retry.state + '&code=code')) },
      f.hostToken,
    );
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: 'google_linked' });
    expect(f.host.googleSubject).toBe('new-subject');
  }));
it.each(['sign-in', 'link'])(
  'rejects another browser callback or transferable ticket for %s',
  async (kind) =>
    fixture(true, async (f) => {
      const other = f.browser();
      const token = kind === 'link' ? f.hostToken : undefined;
      const first = await begin(f, token);
      expect(
        (await other.request('/callback?state=' + first.state + '&code=code')).headers.get(
          'location',
        ),
      ).toContain('error=google_rejected');
      expect(f.exchange).not.toHaveBeenCalled();
      const second = await begin(f, token);
      const ticket = ticketFrom(await f.request('/callback?state=' + second.state + '&code=code'));
      expect((await other.post('/ticket', { ticket }, token)).status).toBe(401);
      expect(f.host.googleSubject).toBeNull();
      expect(f.exchange).not.toHaveBeenCalled();
      expect(f.tickets.size).toBe(0);
    }),
);
it.each(['missing', 'other-account', 'password-change', 'expired-token'])(
  'refuses a link after %s before exchanging the code',
  async (reason) =>
    fixture(true, async (f) => {
      const token =
        reason === 'expired-token'
          ? await f.jwt.signAsync({ sub: f.host.id, sv: 0, guest: false }, { expiresIn: 1 })
          : f.hostToken;
      const { state } = await begin(f, token);
      const ticket = ticketFrom(await f.request('/callback?state=' + state + '&code=code'));
      let current: string | undefined = token;
      if (reason === 'missing') current = undefined;
      if (reason === 'other-account') current = f.guestToken;
      if (reason === 'password-change') f.host.sessionVersion++;
      if (reason === 'expired-token') vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 2000);
      expect((await f.post('/ticket', { ticket }, current)).status).toBe(401);
      expect(f.exchange).not.toHaveBeenCalled();
      expect(f.host.googleSubject).toBeNull();
    }),
);
it('rechecks session revocation after an in-flight provider exchange', async () =>
  fixture(true, async (f) => {
    const { state } = await begin(f, f.hostToken);
    const ticket = ticketFrom(await f.request('/callback?state=' + state + '&code=code'));
    f.exchange.mockImplementation(async () => {
      f.host.sessionVersion++;
      return { subject: 'new-subject', name: 'Host', email: null };
    });
    expect((await f.post('/ticket', { ticket }, f.hostToken)).status).toBe(401);
    expect(f.host.googleSubject).toBeNull();
  }));
it('fails closed for earlier concurrent attempts, expired state/tickets, denial, and provider failures', async () =>
  fixture(true, async (f) => {
    const first = await begin(f);
    await begin(f);
    expect(
      (await f.request('/callback?state=' + first.state + '&code=code')).headers.get('location'),
    ).toContain('error=google_rejected');
    const expired = await begin(f);
    f.states.delete(expired.state);
    expect(
      (await f.request('/callback?state=' + expired.state + '&code=code')).headers.get('location'),
    ).toContain('error=google_rejected');
    const denied = await begin(f);
    expect(
      (await f.request('/callback?state=' + denied.state + '&error=access_denied')).headers.get(
        'location',
      ),
    ).toContain('error=google_rejected');
    expect(f.exchange).not.toHaveBeenCalled();
    const attempt = await begin(f);
    const ticket = ticketFrom(await f.request('/callback?state=' + attempt.state + '&code=code'));
    f.tickets.delete(ticket);
    expect((await f.post('/ticket', { ticket })).status).toBe(401);
    const legacy = await begin(f);
    const legacyTicket = ticketFrom(
      await f.request('/callback?state=' + legacy.state + '&code=code'),
    );
    f.tickets.set(legacyTicket, { token: 'pre-maintenance-ticket' } as unknown as GoogleTicket);
    expect((await f.post('/ticket', { ticket: legacyTicket })).status).toBe(401);
    const failed = await begin(f);
    const failedTicket = ticketFrom(
      await f.request('/callback?state=' + failed.state + '&code=code'),
    );
    f.exchange.mockRejectedValue(googleRejected());
    expect((await f.post('/ticket', { ticket: failedTicket })).status).toBe(401);
    expect(f.users.save).not.toHaveBeenCalled();
  }));
it('shares the bounded account exchange budget and releases slots after failures', async () =>
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
    const { state } = await begin(f);
    const ticket = ticketFrom(await f.request('/callback?state=' + state + '&code=code'));
    const busy = await f.post('/ticket', { ticket });
    expect(busy.status).toBe(503);
    expect(await busy.json()).toMatchObject({ error: 'server_busy' });
    release();
    await active;
    f.exchange.mockResolvedValue({ subject: 'after', name: 'After', email: null });
    await expect(
      f.sessions.exchangeGoogleCode('code', 'verifier', f.exchange),
    ).resolves.toMatchObject({ displayName: 'After' });
  }));
