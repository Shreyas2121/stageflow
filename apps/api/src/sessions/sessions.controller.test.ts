import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { GuestSessionResponse } from '@stageflow/shared';
import type { Repository } from 'typeorm';
import { afterEach, expect, it, vi, type MockInstance } from 'vitest';
import { ApiExceptionFilter } from '../http/api-exception.filter';
import type { User } from '../users/user.entity';
import * as passwords from './password';
import { SessionsController } from './sessions.controller';
import { SessionsService } from './sessions.service';

afterEach(() => vi.restoreAllMocks());

// Vitest's TypeScript transform does not emit Nest's constructor metadata.
Reflect.defineMetadata('design:paramtypes', [SessionsService], SessionsController);

async function fixture(
  test: (context: {
    url: string;
    jwt: JwtService;
    verify: MockInstance<JwtService['verifyAsync']>;
    users: {
      create: ReturnType<typeof vi.fn<(value: Partial<User>) => User>>;
      save: ReturnType<typeof vi.fn<(user: User) => Promise<User>>>;
    };
  }) => Promise<void>,
) {
  const host = {
    id: randomUUID(),
    displayName: 'Returning host',
    email: 'ava@example.com',
    passwordHash: 'stored-hash-marker',
    isGuest: false,
    sessionVersion: 3,
  } as User;
  const query = {
    addSelect: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    getOne: vi.fn(async () => host),
  };
  const users = {
    create: vi.fn((value: Partial<User>) => ({ id: randomUUID(), ...value }) as User),
    save: vi.fn(async (user: User) => user),
    findOneBy: vi.fn(async () => null),
    createQueryBuilder: vi.fn(() => query),
  };
  const jwt = new JwtService({
    secret: randomUUID(),
    signOptions: { algorithm: 'HS256', expiresIn: '12h' },
  });
  const verify = vi.spyOn(jwt, 'verifyAsync');
  const service = new SessionsService(users as unknown as Repository<User>, jwt);
  vi.spyOn(passwords, 'hashPassword').mockResolvedValue('stored-hash-marker');
  vi.spyOn(passwords, 'verifyPassword').mockResolvedValue(true);
  class FixtureModule {}
  Module({
    controllers: [SessionsController],
    providers: [{ provide: SessionsService, useValue: service }],
  })(FixtureModule);
  const app = await NestFactory.create<NestExpressApplication>(FixtureModule, {
    logger: false,
    abortOnError: false,
  });
  app.setGlobalPrefix('api');
  app.useGlobalFilters(new ApiExceptionFilter());
  try {
    await app.listen(0, '127.0.0.1');
    await test({ url: await app.getUrl(), jwt, verify, users });
  } finally {
    await app.close();
  }
}

it.each(['register', 'login'])(
  'POST %s ignores a guest bearer and extra fields and returns a seven-day host token',
  async (route) => {
    await fixture(async ({ url, jwt, verify, users }) => {
      const guestId = randomUUID();
      const guestToken = await jwt.signAsync({ sub: guestId, sv: 0, guest: true });
      const response = await fetch(`${url}/api/sessions/${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${guestToken}` },
        body: JSON.stringify({
          displayName: ' Ava ',
          email: ' AVA@EXAMPLE.COM ',
          password: 'test-password',
          id: guestId,
          userId: guestId,
          isGuest: true,
          sessionVersion: 99,
          passwordHash: 'forged-hash',
          sv: 99,
          guest: true,
        }),
      });
      expect(response.status).toBe(201);
      const session = (await response.json()) as GuestSessionResponse;
      expect(Object.keys(session).sort()).toEqual(['displayName', 'token', 'userId']);
      expect(session.userId).not.toBe(guestId);
      const claims = jwt.verify<{
        sub: string;
        sv: number;
        guest: boolean;
        iat: number;
        exp: number;
      }>(session.token, { algorithms: ['HS256'] });
      expect(claims).toMatchObject({
        sub: session.userId,
        sv: route === 'register' ? 0 : 3,
        guest: false,
      });
      expect(claims.exp - claims.iat).toBe(7 * 24 * 60 * 60);
      expect(verify).not.toHaveBeenCalled();
      if (route === 'register') {
        expect(session.displayName).toBe('Ava');
        expect(users.create).toHaveBeenCalledWith({
          displayName: 'Ava',
          email: 'ava@example.com',
          passwordHash: 'stored-hash-marker',
          isGuest: false,
          sessionVersion: 0,
        });
        expect(users.save).toHaveBeenCalledTimes(1);
      } else {
        expect(session.displayName).toBe('Returning host');
        expect(users.create).not.toHaveBeenCalled();
        expect(users.save).not.toHaveBeenCalled();
      }
    });
  },
);

it.each(['register', 'login'])(
  'POST %s rejects invalid object shapes before any password work or write',
  async (route) => {
    await fixture(async ({ url, users, verify }) => {
      for (const body of [
        null,
        42,
        'text',
        [],
        [{ email: 'ava@example.com', password: 'test-password' }],
        {},
      ]) {
        const response = await fetch(`${url}/api/sessions/${route}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        expect(response.status).toBe(400);
        await response.text();
      }
      expect(passwords.hashPassword).not.toHaveBeenCalled();
      expect(passwords.verifyPassword).not.toHaveBeenCalled();
      expect(users.save).not.toHaveBeenCalled();
      expect(verify).not.toHaveBeenCalled();
    });
  },
);

it.each([
  { route: 'register', field: 'displayName', error: 'invalid_display_name' },
  { route: 'register', field: 'email', error: 'invalid_email' },
  { route: 'register', field: 'password', error: 'invalid_password' },
  { route: 'login', field: 'email', error: 'invalid_email' },
  { route: 'login', field: 'password', error: 'invalid_password' },
])('POST $route returns $error for an invalid $field', async ({ route, field, error }) => {
  await fixture(async ({ url, users }) => {
    const response = await fetch(`${url}/api/sessions/${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        displayName: 'Ava',
        email: 'ava@example.com',
        password: 'test-password',
        [field]: [],
      }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ statusCode: 400, error });
    expect(users.save).not.toHaveBeenCalled();
  });
});
