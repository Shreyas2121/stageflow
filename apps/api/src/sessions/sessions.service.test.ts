import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JwtService } from '@nestjs/jwt';
import { QueryFailedError, type EntityManager, type Repository } from 'typeorm';
import type { User } from '../users/user.entity';
import { SessionsService } from './sessions.service';
import { env } from '../config/env';
import * as passwords from './password';
import { ApiException } from '../http/api.exception';

afterEach(() => vi.restoreAllMocks());

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

describe('host accounts', () => {
  function setup() {
    const host = {
      id: randomUUID(),
      displayName: 'Ava',
      email: 'ava@example.com',
      passwordHash: 'stored-hash-marker',
      isGuest: false,
      sessionVersion: 3,
    } as User;
    const query = {
      addSelect: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      getOne: vi.fn(async (): Promise<User | null> => host),
    };
    const users = {
      create: vi.fn(
        (value: Partial<User>) => ({ id: randomUUID(), sessionVersion: 0, ...value }) as User,
      ),
      save: vi.fn(async (user: User) => user),
      findOneBy: vi.fn(async (): Promise<User | null> => null),
      createQueryBuilder: vi.fn(() => query),
    };
    const jwt = { signAsync: vi.fn(async () => 'host-token') };
    const service = new SessionsService(
      users as unknown as Repository<User>,
      jwt as unknown as JwtService,
    );
    return { service, users, query, jwt, host };
  }

  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((onResolve, onReject) => {
      resolve = onResolve;
      reject = onReject;
    });
    return { promise, resolve, reject };
  }

  it('registers and logs in the same host using real password hashing', async () => {
    const { service, users, query, jwt } = setup();
    const registered = await service.register(' Ava ', ' Ava@Example.com ', ' test-password ');
    expect(users.findOneBy).toHaveBeenCalledWith({ email: 'ava@example.com' });
    expect(users.create).toHaveBeenCalledWith({
      displayName: 'Ava',
      email: 'ava@example.com',
      passwordHash: expect.any(String),
      isGuest: false,
      sessionVersion: 0,
    });
    const saved = users.save.mock.calls[0]![0];
    expect(saved.passwordHash).toContain('$12$');
    expect(saved.passwordHash).not.toContain('test-password');
    expect(registered).toEqual({ token: 'host-token', userId: saved.id, displayName: 'Ava' });
    expect(jwt.signAsync).toHaveBeenLastCalledWith(
      { sub: saved.id, sv: 0, guest: false },
      { expiresIn: '7d' },
    );

    saved.sessionVersion = 3;
    query.getOne.mockResolvedValue(saved);
    expect(await service.login('AVA@EXAMPLE.COM', ' test-password ')).toEqual(registered);
    expect(query.addSelect).toHaveBeenCalledWith('user.passwordHash');
    expect(query.where).toHaveBeenCalledWith('user.email = :email', { email: 'ava@example.com' });
    expect(jwt.signAsync).toHaveBeenLastCalledWith(
      { sub: saved.id, sv: 3, guest: false },
      { expiresIn: '7d' },
    );
    expect(users.save).toHaveBeenCalledTimes(1);
  });

  it('returns the same error for a wrong password and a missing email without writing', async () => {
    const { service, users, query, jwt } = setup();
    vi.spyOn(passwords, 'hashPassword').mockResolvedValue('dummy-hash-marker');
    const compare = vi.spyOn(passwords, 'verifyPassword').mockResolvedValue(false);
    const failure = {
      response: { statusCode: 401, error: 'unauthorized', message: 'Email or password is wrong.' },
    };
    await expect(service.login('ava@example.com', 'wrong-password')).rejects.toMatchObject(failure);
    expect(compare).toHaveBeenLastCalledWith('wrong-password', 'stored-hash-marker');
    query.getOne.mockResolvedValue(null);
    await expect(service.login('missing@example.com', 'wrong-password')).rejects.toMatchObject(
      failure,
    );
    expect(compare).toHaveBeenLastCalledWith('wrong-password', 'dummy-hash-marker');
    expect(users.save).not.toHaveBeenCalled();
    expect(jwt.signAsync).not.toHaveBeenCalled();
  });

  it('maps a uniqueness race and a later duplicate to email_taken without another save', async () => {
    const { service, users, jwt, host } = setup();
    const hash = vi.spyOn(passwords, 'hashPassword').mockResolvedValue('hash-marker');
    users.findOneBy.mockResolvedValueOnce(null).mockResolvedValue(host);
    users.save.mockRejectedValueOnce(
      new QueryFailedError(
        'INSERT INTO users',
        [],
        Object.assign(new Error('duplicate'), { code: '23505' }),
      ),
    );
    const failure = {
      response: {
        statusCode: 409,
        error: 'email_taken',
        message: 'That email is already registered.',
      },
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(
        service.register('Ava', 'AVA@EXAMPLE.COM', 'test-password'),
      ).rejects.toMatchObject(failure);
    }
    expect(users.save).toHaveBeenCalledTimes(1);
    expect(hash).toHaveBeenCalledTimes(1);
    expect(jwt.signAsync).not.toHaveBeenCalled();
    expect(host.sessionVersion).toBe(3);
  });

  it.each(['register lookup', 'register save', 'login lookup'])(
    'sanitizes a failed %s before it can log account parameters',
    async (operation) => {
      const { service, users, query, jwt } = setup();
      vi.spyOn(passwords, 'hashPassword').mockResolvedValue('hash-marker');
      const failure = new QueryFailedError(
        'account query',
        ['private-email-marker', 'private-hash-marker'],
        Object.assign(new Error('database unavailable'), { code: '08006' }),
      );
      if (operation === 'register lookup') users.findOneBy.mockRejectedValueOnce(failure);
      else if (operation === 'register save') users.save.mockRejectedValueOnce(failure);
      else query.getOne.mockRejectedValueOnce(failure);
      const request =
        operation === 'login lookup'
          ? service.login('ava@example.com', 'test-password')
          : service.register('Ava', 'ava@example.com', 'test-password');
      const error: unknown = await request.catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(ApiException);
      expect(error).toMatchObject({
        response: {
          statusCode: 503,
          error: 'server_busy',
          message: 'Account sign-in is busy. Try again shortly.',
        },
      });
      expect(error).not.toHaveProperty('query');
      expect(error).not.toHaveProperty('parameters');
      expect(error).not.toHaveProperty('cause');
      expect(jwt.signAsync).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      displayName: '',
      email: 'ava@example.com',
      password: 'test-password',
      error: 'invalid_display_name',
      message: 'Enter a display name from 1 to 40 characters.',
    },
    {
      displayName: 'Ava',
      email: 'invalid',
      password: 'test-password',
      error: 'invalid_email',
      message: 'Enter a valid email address.',
    },
    {
      displayName: 'Ava',
      email: 'ava@example.com',
      password: 'short',
      error: 'invalid_password',
      message: 'Use 8 to 72 characters, without control characters.',
    },
  ])(
    'rejects $error before registration work',
    async ({ displayName, email, password, error, message }) => {
      const { service, users } = setup();
      const hash = vi.spyOn(passwords, 'hashPassword');
      await expect(service.register(displayName, email, password)).rejects.toMatchObject({
        response: { statusCode: 400, error, message },
      });
      expect(users.findOneBy).not.toHaveBeenCalled();
      expect(users.save).not.toHaveBeenCalled();
      expect(hash).not.toHaveBeenCalled();
    },
  );

  it.each([
    { email: 'invalid', password: 'test-password', error: 'invalid_email' },
    { email: 'ava@example.com', password: 'short', error: 'invalid_password' },
  ])('rejects $error before login work', async ({ email, password, error }) => {
    const { service, users } = setup();
    const compare = vi.spyOn(passwords, 'verifyPassword');
    await expect(service.login(email, password)).rejects.toMatchObject({
      response: { statusCode: 400, error },
    });
    expect(users.createQueryBuilder).not.toHaveBeenCalled();
    expect(compare).not.toHaveBeenCalled();
  });

  it('shares a single lazy dummy hash across concurrent and later missing-email logins', async () => {
    const { service, query } = setup();
    query.getOne.mockResolvedValue(null);
    const gate = deferred<string>();
    const hash = vi.spyOn(passwords, 'hashPassword').mockReturnValue(gate.promise);
    const compare = vi.spyOn(passwords, 'verifyPassword').mockResolvedValue(false);
    const active = [
      service.login('one@example.com', 'test-password'),
      service.login('two@example.com', 'test-password'),
    ];
    const settled = Promise.allSettled(active);
    await vi.waitFor(() => expect(hash).toHaveBeenCalledTimes(1));
    gate.resolve('dummy-hash-marker');
    expect((await settled).map((result) => result.status)).toEqual(['rejected', 'rejected']);
    await expect(service.login('three@example.com', 'test-password')).rejects.toMatchObject({
      response: { error: 'unauthorized' },
    });
    expect(hash).toHaveBeenCalledTimes(1);
    expect(compare).toHaveBeenCalledTimes(3);
    expect(compare).toHaveBeenLastCalledWith('test-password', 'dummy-hash-marker');
  });

  it('retries a failed dummy hash and never signs for a guest or a row without credentials', async () => {
    const { service, query, host, jwt } = setup();
    const failure = new Error('hash unavailable');
    const hash = vi
      .spyOn(passwords, 'hashPassword')
      .mockRejectedValueOnce(failure)
      .mockResolvedValue('dummy-hash-marker');
    vi.spyOn(passwords, 'verifyPassword').mockResolvedValue(true);
    query.getOne.mockResolvedValue(null);
    await expect(service.login('missing@example.com', 'test-password')).rejects.toMatchObject({
      response: { statusCode: 503, error: 'server_busy' },
    });
    await expect(service.login('missing@example.com', 'test-password')).rejects.toMatchObject({
      response: { error: 'unauthorized' },
    });
    expect(hash).toHaveBeenCalledTimes(2);
    for (const user of [
      { ...host, isGuest: true },
      { ...host, passwordHash: null },
    ]) {
      query.getOne.mockResolvedValue(user);
      await expect(service.login('ava@example.com', 'test-password')).rejects.toMatchObject({
        response: { error: 'unauthorized' },
      });
    }
    expect(jwt.signAsync).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'bounds mixed register/login work and releases all slots after failure=%s',
    async (fail) => {
      const { service } = setup();
      const gate = deferred<void>();
      const hash = vi.spyOn(passwords, 'hashPassword').mockImplementation(async () => {
        await gate.promise;
        return 'hash-marker';
      });
      const compare = vi.spyOn(passwords, 'verifyPassword').mockImplementation(async () => {
        await gate.promise;
        return true;
      });
      const active = Array.from({ length: env.GUEST_PENDING_LIMIT }, (_, index) =>
        index % 2 === 0
          ? service.register('Ava', 'ava@example.com', 'test-password')
          : service.login('ava@example.com', 'test-password'),
      );
      const settled = Promise.allSettled(active);
      await vi.waitFor(() =>
        expect(hash.mock.calls.length + compare.mock.calls.length).toBe(env.GUEST_PENDING_LIMIT),
      );
      const failure = {
        response: {
          statusCode: 503,
          error: 'server_busy',
          message: 'Account sign-in is busy. Try again shortly.',
        },
      };
      await expect(
        service.register('Ava', 'ava@example.com', 'test-password'),
      ).rejects.toMatchObject(failure);
      await expect(service.login('ava@example.com', 'test-password')).rejects.toMatchObject(
        failure,
      );
      expect(hash.mock.calls.length + compare.mock.calls.length).toBe(env.GUEST_PENDING_LIMIT);
      await expect(service.createGuest('Guest')).resolves.toMatchObject({
        token: 'host-token',
        displayName: 'Guest',
      });
      if (fail) gate.reject(new Error('password work failed'));
      else gate.resolve();
      expect(
        (await settled).every((result) => result.status === (fail ? 'rejected' : 'fulfilled')),
      ).toBe(true);
      compare.mockResolvedValue(true);
      await expect(service.login('ava@example.com', 'test-password')).resolves.toMatchObject({
        token: 'host-token',
      });
    },
  );
});

describe('credential changes', () => {
  function setup(isGuest = true) {
    const original = {
      id: randomUUID(),
      displayName: 'Ava',
      email: isGuest ? null : 'ava@example.com',
      passwordHash: isGuest ? null : 'old-hash-marker',
      isGuest,
      sessionVersion: 0,
    } as User;
    let row = { ...original };
    const query = {
      addSelect: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      setLock: vi.fn().mockReturnThis(),
      getOne: vi.fn(async (): Promise<User | null> => ({ ...row })),
    };
    const users = {
      findOneBy: vi.fn(async (criteria: Partial<User>): Promise<User | null> =>
        criteria.id === row.id ? { ...row } : null,
      ),
      createQueryBuilder: vi.fn(() => query),
      save: vi.fn(async (user: User) => {
        row = { ...user };
        return { ...row };
      }),
      manager: {
        transaction: vi.fn(async (work: (manager: EntityManager) => Promise<User>) =>
          work({ getRepository: () => users } as unknown as EntityManager),
        ),
      },
    };
    const jwt = new JwtService({
      secret: randomUUID(),
      signOptions: { algorithm: 'HS256', expiresIn: '12h' },
    });
    const sign = vi.spyOn(jwt, 'signAsync');
    const hash = vi.spyOn(passwords, 'hashPassword').mockResolvedValue('new-hash-marker');
    const compare = vi.spyOn(passwords, 'verifyPassword').mockResolvedValue(true);
    const membership = vi.fn<(userId: string) => Promise<boolean>>(async () => false);
    const service = new SessionsService(users as unknown as Repository<User>, jwt);
    return { original, users, query, jwt, sign, hash, compare, membership, service };
  }

  it('promotes the same guest id, preserves the name, and invalidates its old token', async () => {
    const { service, original, users, query, jwt, sign, membership } = setup();
    const oldToken = await jwt.signAsync({ sub: original.id, sv: 0, guest: true });
    sign.mockClear();
    const result = await service.promote(
      original,
      ' AVA@EXAMPLE.COM ',
      ' new-password ',
      membership,
    );
    expect(result).toMatchObject({ userId: original.id, displayName: original.displayName });
    expect(users.save).toHaveBeenCalledExactlyOnceWith({
      ...original,
      email: 'ava@example.com',
      passwordHash: 'new-hash-marker',
      isGuest: false,
      sessionVersion: 1,
    });
    expect(query.addSelect).toHaveBeenCalledWith('user.passwordHash');
    expect(query.where).toHaveBeenCalledWith('user.id = :id', { id: original.id });
    expect(query.setLock).toHaveBeenCalledWith('pessimistic_write');
    expect(membership.mock.calls).toEqual([[original.id], [original.id]]);
    expect(sign).toHaveBeenCalledExactlyOnceWith(
      { sub: original.id, sv: 1, guest: false },
      { expiresIn: '7d' },
    );
    await expect(service.verifyToken(oldToken)).rejects.toMatchObject({
      response: { error: 'unauthorized' },
    });
    await expect(service.verifyToken(result.token)).resolves.toMatchObject({
      id: original.id,
      isGuest: false,
      sessionVersion: 1,
    });
    expect(original).toMatchObject({ isGuest: true, sessionVersion: 0, email: null });
  });

  it('refuses a membership before hashing or writing', async () => {
    const { service, original, users, hash, sign, membership } = setup();
    membership.mockResolvedValue(true);
    await expect(
      service.promote(original, 'ava@example.com', 'new-password', membership),
    ).rejects.toMatchObject({
      response: {
        statusCode: 409,
        error: 'membership_active',
        message: 'Leave the live room before creating a host account.',
      },
    });
    expect(users.save).not.toHaveBeenCalled();
    expect(hash).not.toHaveBeenCalled();
    expect(sign).not.toHaveBeenCalled();
  });

  it.each(['membership', 'Redis failure'])(
    'restores all previous credential columns after a second-scan %s',
    async (reason) => {
      const { service, original, users, sign, membership } = setup();
      membership.mockResolvedValueOnce(false);
      if (reason === 'membership') membership.mockResolvedValueOnce(true);
      else membership.mockRejectedValueOnce(new Error('Redis unavailable'));
      await expect(
        service.promote(original, 'ava@example.com', 'new-password', membership),
      ).rejects.toMatchObject({
        response: {
          statusCode: reason === 'membership' ? 409 : 503,
          error: reason === 'membership' ? 'membership_active' : 'server_busy',
        },
      });
      expect(users.save).toHaveBeenCalledTimes(2);
      expect(users.save).toHaveBeenLastCalledWith(original);
      expect(sign).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, '23505'])(
    'returns server_busy without signing when restore fails with %s',
    async (code) => {
      const { service, original, users, membership, sign } = setup();
      membership.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
      users.save
        .mockImplementationOnce(async (user) => user)
        .mockRejectedValueOnce(Object.assign(new Error('restore unavailable'), { code }));
      await expect(
        service.promote(original, 'ava@example.com', 'new-password', membership),
      ).rejects.toMatchObject({ response: { statusCode: 503, error: 'server_busy' } });
      expect(users.save).toHaveBeenLastCalledWith(original);
      expect(sign).not.toHaveBeenCalled();
    },
  );

  it('returns server_busy without writing or signing on the first Redis failure', async () => {
    const { service, original, users, membership, sign } = setup();
    membership.mockRejectedValue(new Error('Redis unavailable'));
    await expect(
      service.promote(original, 'ava@example.com', 'new-password', membership),
    ).rejects.toMatchObject({ response: { statusCode: 503, error: 'server_busy' } });
    expect(users.save).not.toHaveBeenCalled();
    expect(sign).not.toHaveBeenCalled();
  });

  it.each(['existing', 'race'])(
    'refuses an %s email conflict without writing another user or issuing a token',
    async (reason) => {
      const { service, original, users, membership, sign } = setup();
      const other = { ...original, id: randomUUID(), isGuest: false, email: 'ava@example.com' };
      if (reason === 'existing') users.findOneBy.mockResolvedValueOnce(other);
      else
        users.save.mockRejectedValueOnce(
          new QueryFailedError(
            'UPDATE users',
            [],
            Object.assign(new Error('duplicate'), { code: '23505' }),
          ),
        );
      await expect(
        service.promote(original, 'ava@example.com', 'new-password', membership),
      ).rejects.toMatchObject({
        response: {
          statusCode: 409,
          error: 'email_taken',
          message: 'That email is already registered.',
        },
      });
      for (const [user] of users.save.mock.calls) expect(user.id).toBe(original.id);
      expect(users.save).toHaveBeenCalledTimes(reason === 'existing' ? 0 : 1);
      expect(sign).not.toHaveBeenCalled();
    },
  );

  it('changes the password from version 0 to 1 and rejects the old host token', async () => {
    const { service, original, users, jwt, sign, compare, hash } = setup(false);
    const oldToken = await jwt.signAsync({ sub: original.id, sv: 0, guest: false });
    sign.mockClear();
    const result = await service.changePassword(original, ' old-password ', ' new-password ');
    expect(compare).toHaveBeenCalledWith(' old-password ', original.passwordHash);
    expect(hash).toHaveBeenCalledWith(' new-password ');
    expect(users.save).toHaveBeenCalledExactlyOnceWith({
      ...original,
      passwordHash: 'new-hash-marker',
      sessionVersion: 1,
    });
    expect(sign).toHaveBeenCalledExactlyOnceWith(
      { sub: original.id, sv: 1, guest: false },
      { expiresIn: '7d' },
    );
    await expect(service.verifyToken(oldToken)).rejects.toMatchObject({
      response: { statusCode: 401, error: 'unauthorized' },
    });
    await expect(service.verifyToken(result.token)).resolves.toMatchObject({
      id: original.id,
      sessionVersion: 1,
    });
  });

  it.each(['wrong', 'missing hash'])(
    'rejects a %s current password without hashing, writing, or signing',
    async (reason) => {
      const { service, original, users, query, compare, hash, sign } = setup(false);
      if (reason === 'wrong') compare.mockResolvedValue(false);
      else query.getOne.mockResolvedValue({ ...original, passwordHash: null });
      await expect(
        service.changePassword(original, 'old-password', 'new-password'),
      ).rejects.toMatchObject({
        response: {
          statusCode: 401,
          error: 'wrong_password',
          message: 'The current password is wrong.',
        },
      });
      expect(hash).not.toHaveBeenCalled();
      expect(users.save).not.toHaveBeenCalled();
      expect(sign).not.toHaveBeenCalled();
    },
  );

  it.each(['password', 'promote'])('refuses the wrong account kind for %s', async (route) => {
    const { service, original, users, membership, hash } = setup(route === 'password');
    const result =
      route === 'password'
        ? service.changePassword(original, 'old-password', 'new-password')
        : service.promote(original, 'ava@example.com', 'new-password', membership);
    await expect(result).rejects.toMatchObject({
      response: { statusCode: 403, error: route === 'password' ? 'not_registered' : 'not_guest' },
    });
    expect(users.manager.transaction).not.toHaveBeenCalled();
    expect(hash).not.toHaveBeenCalled();
  });

  it.each(['missing', 'version', 'kind'])(
    'refuses a %s user after acquiring the credential lock',
    async (reason) => {
      const { service, original, users, query, membership, hash } = setup();
      query.getOne.mockResolvedValue(
        reason === 'missing'
          ? null
          : {
              ...original,
              sessionVersion: reason === 'version' ? 1 : 0,
              isGuest: reason !== 'kind',
            },
      );
      await expect(
        service.promote(original, 'ava@example.com', 'new-password', membership),
      ).rejects.toMatchObject({ response: { statusCode: 401, error: 'unauthorized' } });
      expect(users.save).not.toHaveBeenCalled();
      expect(hash).not.toHaveBeenCalled();
      expect(membership).not.toHaveBeenCalled();
    },
  );

  it.each(['password', 'promote'])(
    'shares register/login capacity with %s and releases it on failure',
    async (route) => {
      const { service, original, users, membership, hash, compare } = setup(route === 'promote');
      let reject!: (error: Error) => void;
      const gate = new Promise<string>((_resolve, fail) => {
        reject = fail;
      });
      hash.mockReturnValue(gate);
      const active = Array.from({ length: env.GUEST_PENDING_LIMIT }, () =>
        service.register('Ava', 'ava@example.com', 'test-password'),
      );
      const settled = Promise.allSettled(active);
      await vi.waitFor(() => expect(hash).toHaveBeenCalledTimes(env.GUEST_PENDING_LIMIT));
      const result =
        route === 'password'
          ? service.changePassword(original, 'old-password', 'new-password')
          : service.promote(original, 'ava@example.com', 'new-password', membership);
      await expect(result).rejects.toMatchObject({
        response: { statusCode: 503, error: 'server_busy' },
      });
      expect(users.manager.transaction).not.toHaveBeenCalled();
      expect(compare).not.toHaveBeenCalled();
      reject(new Error('password work failed'));
      await settled;
      hash.mockResolvedValue('new-hash-marker');
      await expect(
        route === 'password'
          ? service.changePassword(original, 'old-password', 'new-password')
          : service.promote(original, 'ava@example.com', 'new-password', membership),
      ).resolves.toMatchObject({ userId: original.id });
    },
  );

  it.each(['password', 'promote'])(
    'holds the shared cap during %s work and releases it after failure',
    async (route) => {
      const { service, original, users, membership, compare } = setup(route === 'promote');
      let reject!: (error: Error) => void;
      const gate = new Promise<never>((_resolve, fail) => {
        reject = fail;
      });
      if (route === 'password') compare.mockReturnValue(gate);
      else membership.mockReturnValue(gate);
      const run = () =>
        route === 'password'
          ? service.changePassword(original, 'old-password', 'new-password')
          : service.promote(original, 'ava@example.com', 'new-password', membership);
      const active = Promise.allSettled(Array.from({ length: env.GUEST_PENDING_LIMIT }, run));
      await vi.waitFor(() =>
        expect(route === 'password' ? compare : membership).toHaveBeenCalledTimes(
          env.GUEST_PENDING_LIMIT,
        ),
      );
      for (const result of [
        service.register('Ava', 'ava@example.com', 'new-password'),
        service.login('ava@example.com', 'new-password'),
        run(),
      ]) {
        await expect(result).rejects.toMatchObject({ response: { error: 'server_busy' } });
      }
      reject(new Error('credential work failed'));
      expect((await active).every((result) => result.status === 'rejected')).toBe(true);
      expect(users.save).not.toHaveBeenCalled();
      compare.mockResolvedValue(true);
      membership.mockResolvedValue(false);
      await expect(run()).resolves.toMatchObject({ userId: original.id });
    },
  );

  it.each(['password', 'promote'])(
    'sanitizes credential-bearing database errors during %s',
    async (route) => {
      const { service, original, users, membership, sign } = setup(route === 'promote');
      users.save.mockRejectedValue(
        new QueryFailedError(
          'UPDATE users SET password_hash = $1',
          ['private-hash-marker'],
          new Error('private failure marker'),
        ),
      );
      const result =
        route === 'password'
          ? service.changePassword(original, 'old-password', 'new-password')
          : service.promote(original, 'ava@example.com', 'new-password', membership);
      const error: unknown = await result.catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(ApiException);
      expect(error).toMatchObject({ response: { statusCode: 503, error: 'server_busy' } });
      expect(JSON.stringify(error)).not.toContain('private');
      expect(error).not.toHaveProperty('cause');
      expect(sign).not.toHaveBeenCalled();
    },
  );
});
