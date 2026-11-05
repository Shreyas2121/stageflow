import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { JwtService } from '@nestjs/jwt';
import type { Repository } from 'typeorm';
import type { User } from '../users/user.entity';
import { SessionsService } from './sessions.service';
import { env } from '../config/env';

it('bounds in-flight guest creation even if callers close their HTTP connections', async () => {
  let release!: (user: User) => void;
  const gate = new Promise<User>((resolve) => {
    release = resolve;
  });
  const users = { create: vi.fn((value: unknown) => value), save: vi.fn(() => gate) };
  const jwt = { signAsync: vi.fn(async () => 'signed-token') };
  const service = new SessionsService(
    users as unknown as Repository<User>,
    jwt as unknown as JwtService,
  );
  const active = Array.from({ length: env.GUEST_PENDING_LIMIT }, () =>
    service.createGuest('Guest'),
  );
  await expect(service.createGuest('Excess')).rejects.toMatchObject({
    response: { statusCode: 503, error: 'server_busy' },
  });
  expect(users.create).toHaveBeenCalledTimes(env.GUEST_PENDING_LIMIT);
  release({ id: 'test-user', displayName: 'Guest', isGuest: true, sessionVersion: 0 } as User);
  await Promise.all(active);
  expect(await service.createGuest('Next')).toMatchObject({ token: 'signed-token' });
  expect(users.create).toHaveBeenLastCalledWith({ displayName: 'Next', isGuest: true });
  expect(jwt.signAsync).toHaveBeenCalledTimes(env.GUEST_PENDING_LIMIT + 1);
  expect(jwt.signAsync).toHaveBeenLastCalledWith(
    { sub: 'test-user', sv: 0, guest: true },
    { expiresIn: '12h' },
  );
});

describe('verifyToken', () => {
  const userId = randomUUID();
  const jwt = new JwtService({
    secret: randomUUID(),
    signOptions: { algorithm: 'HS256', expiresIn: '12h' },
  });

  function setup(isGuest = true, sessionVersion = 0) {
    const user = { id: userId, displayName: 'Guest', isGuest, sessionVersion } as User;
    const users = { findOneBy: vi.fn(async (): Promise<User | null> => user) };
    const service = new SessionsService(users as unknown as Repository<User>, jwt);
    return { user, users, service };
  }

  it.each([
    { name: 'legacy guest', isGuest: true, version: 0, claims: {} },
    { name: 'guest', isGuest: true, version: 0, claims: { sv: 0, guest: true } },
    { name: 'guest without sv', isGuest: true, version: 0, claims: { guest: true } },
    { name: 'guest without guest', isGuest: true, version: 0, claims: { sv: 0 } },
    { name: 'host', isGuest: false, version: 0, claims: { sv: 0, guest: false } },
    { name: 'host without sv', isGuest: false, version: 0, claims: { guest: false } },
    { name: 'versioned host', isGuest: false, version: 2, claims: { sv: 2, guest: false } },
  ])('accepts a matching $name token', async ({ isGuest, version, claims }) => {
    const { user, users, service } = setup(isGuest, version);
    const token = await jwt.signAsync({ sub: userId, ...claims });
    expect(await service.verifyToken(token)).toBe(user);
    expect(users.findOneBy).toHaveBeenCalledWith({ id: userId });
  });

  it.each([
    { name: 'newer version', isGuest: true, version: 0, claims: { sv: 1, guest: true } },
    { name: 'older version', isGuest: false, version: 1, claims: { sv: 0, guest: false } },
    { name: 'missing version', isGuest: true, version: 1, claims: { guest: true } },
    { name: 'host claim on guest', isGuest: true, version: 0, claims: { sv: 0, guest: false } },
    { name: 'guest claim on host', isGuest: false, version: 0, claims: { sv: 0, guest: true } },
    { name: 'legacy token on host', isGuest: false, version: 0, claims: {} },
    { name: 'missing guest on host', isGuest: false, version: 0, claims: { sv: 0 } },
    { name: 'string guest', isGuest: true, version: 0, claims: { sv: 0, guest: 'true' } },
    { name: 'numeric guest', isGuest: false, version: 0, claims: { sv: 0, guest: 0 } },
    { name: 'null guest', isGuest: false, version: 0, claims: { sv: 0, guest: null } },
  ])('rejects a $name token', async ({ isGuest, version, claims }) => {
    const { service } = setup(isGuest, version);
    const token = await jwt.signAsync({ sub: userId, ...claims });
    await expect(service.verifyToken(token)).rejects.toMatchObject({
      response: { statusCode: 401, error: 'unauthorized' },
    });
  });

  it.each(['0', 0.5, null, false, {}, []])('rejects non-integer sv %j', async (sv) => {
    const { service, users } = setup();
    const token = await jwt.signAsync({ sub: userId, sv, guest: true });
    await expect(service.verifyToken(token)).rejects.toMatchObject({
      response: { statusCode: 401, error: 'unauthorized' },
    });
    expect(users.findOneBy).not.toHaveBeenCalled();
  });

  it('rejects a missing user', async () => {
    const { service, users } = setup();
    users.findOneBy.mockResolvedValue(null);
    const token = await jwt.signAsync({ sub: userId, sv: 0, guest: true });
    await expect(service.verifyToken(token)).rejects.toMatchObject({
      response: { statusCode: 401, error: 'unauthorized' },
    });
  });

  it.each([undefined, null, 42, '', 'not-a-token'])('rejects invalid bearer %j', async (token) => {
    const { service, users } = setup();
    await expect(service.verifyToken(token)).rejects.toMatchObject({
      response: { statusCode: 401, error: 'unauthorized' },
    });
    expect(users.findOneBy).not.toHaveBeenCalled();
  });

  it.each([{}, { sub: 42 }, { sub: 'not-a-uuid' }])(
    'rejects invalid subject %j',
    async (claims) => {
      const { service, users } = setup();
      const token = await jwt.signAsync(claims);
      await expect(service.verifyToken(token)).rejects.toMatchObject({
        response: { statusCode: 401, error: 'unauthorized' },
      });
      expect(users.findOneBy).not.toHaveBeenCalled();
    },
  );

  it('rejects expired tokens and other signing algorithms', async () => {
    const { service, users } = setup();
    for (const options of [{ expiresIn: -1 }, { algorithm: 'HS384' as const }]) {
      const token = await jwt.signAsync({ sub: userId, sv: 0, guest: true }, options);
      await expect(service.verifyToken(token)).rejects.toMatchObject({
        response: { statusCode: 401, error: 'unauthorized' },
      });
    }
    expect(users.findOneBy).not.toHaveBeenCalled();
  });
});
