import { isUuid, parseDisplayName, parseEmail, parsePassword } from '@stageflow/shared';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { JwtService } from '@nestjs/jwt';
import { Repository } from 'typeorm';
import type { GuestSessionResponse } from '@stageflow/shared';
import { User } from '../users/user.entity';
import { ApiException } from '../http/api.exception';
import { env } from '../config/env';
import { hashPassword, verifyPassword } from './password';

@Injectable()
export class SessionsService {
  private pendingGuests = 0;
  private pendingPasswords = 0;
  private dummyPasswordHash: Promise<string> | undefined;
  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly jwt: JwtService,
  ) {}

  async verifyToken(token: unknown): Promise<User> {
    const unauthorized = new ApiException(
      401,
      'unauthorized',
      'Sign in as a guest before calling this route.',
    );
    if (typeof token !== 'string' || !token) throw unauthorized;
    let payload: unknown;
    try {
      payload = await this.jwt.verifyAsync<{ sub?: unknown; sv?: unknown; guest?: unknown }>(
        token,
        { algorithms: ['HS256'] },
      );
    } catch {
      throw unauthorized;
    }
    if (
      typeof payload !== 'object' ||
      payload === null ||
      !('sub' in payload) ||
      typeof payload.sub !== 'string' ||
      !isUuid(payload.sub)
    ) {
      throw unauthorized;
    }
    const sessionVersion = 'sv' in payload ? payload.sv : 0;
    if (!Number.isInteger(sessionVersion)) throw unauthorized;
    const user = await this.users.findOneBy({ id: payload.sub });
    if (
      !user ||
      sessionVersion !== user.sessionVersion ||
      ('guest' in payload
        ? typeof payload.guest !== 'boolean' || payload.guest !== user.isGuest
        : !user.isGuest)
    ) {
      throw unauthorized;
    }
    return user;
  }

  async createGuest(input: unknown): Promise<GuestSessionResponse> {
    const parsed = parseDisplayName(input);
    if (!parsed.ok) throw new ApiException(400, parsed.error, parsed.message);
    if (this.pendingGuests >= env.GUEST_PENDING_LIMIT)
      throw new ApiException(503, 'server_busy', 'Guest creation is busy. Try again shortly.');
    this.pendingGuests++;
    try {
      const user = await this.users.save(
        this.users.create({ displayName: parsed.value, isGuest: true }),
      );
      const token = await this.jwt.signAsync(
        { sub: user.id, sv: user.sessionVersion, guest: true },
        { expiresIn: '12h' },
      );
      return { token, userId: user.id, displayName: user.displayName };
    } finally {
      this.pendingGuests--;
    }
  }

  async register(
    displayNameInput: unknown,
    emailInput: unknown,
    passwordInput: unknown,
  ): Promise<GuestSessionResponse> {
    const displayName = parseDisplayName(displayNameInput);
    if (!displayName.ok) throw new ApiException(400, displayName.error, displayName.message);
    const email = parseEmail(emailInput);
    if (!email.ok) throw new ApiException(400, email.error, email.message);
    const password = parsePassword(passwordInput);
    if (!password.ok) throw new ApiException(400, password.error, password.message);
    const emailTaken = new ApiException(409, 'email_taken', 'That email is already registered.');

    return this.withPasswordWork(async () => {
      if (await this.users.findOneBy({ email: email.value })) throw emailTaken;
      const draft = this.users.create({
        displayName: displayName.value,
        email: email.value,
        passwordHash: await hashPassword(password.value),
        isGuest: false,
        sessionVersion: 0,
      });
      let user: User;
      try {
        user = await this.users.save(draft);
      } catch (error: unknown) {
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === '23505'
        ) {
          throw emailTaken;
        }
        throw error;
      }
      return this.hostSession(user);
    });
  }

  async login(emailInput: unknown, passwordInput: unknown): Promise<GuestSessionResponse> {
    const email = parseEmail(emailInput);
    if (!email.ok) throw new ApiException(400, email.error, email.message);
    const password = parsePassword(passwordInput);
    if (!password.ok) throw new ApiException(400, password.error, password.message);

    return this.withPasswordWork(async () => {
      const user = await this.users
        .createQueryBuilder('user')
        .addSelect('user.passwordHash')
        .where('user.email = :email', { email: email.value })
        .getOne();
      const passwordHash = user?.passwordHash || (await this.dummyHash());
      const matches = await verifyPassword(password.value, passwordHash);
      if (!user || user.isGuest || !user.passwordHash || !matches) {
        throw new ApiException(401, 'unauthorized', 'Email or password is wrong.');
      }
      return this.hostSession(user);
    });
  }

  async changePassword(
    caller: User,
    currentPasswordInput: unknown,
    passwordInput: unknown,
  ): Promise<GuestSessionResponse> {
    if (caller.isGuest) {
      throw new ApiException(
        403,
        'not_registered',
        'Create a host account before changing its password.',
      );
    }
    const currentPassword = parsePassword(currentPasswordInput);
    if (!currentPassword.ok)
      throw new ApiException(400, currentPassword.error, currentPassword.message);
    const password = parsePassword(passwordInput);
    if (!password.ok) throw new ApiException(400, password.error, password.message);

    return this.withPasswordWork(async () => {
      const user = await this.users.manager.transaction(async (manager) => {
        const users = manager.getRepository(User);
        const current = await this.lockUser(users, caller);
        if (
          !current.passwordHash ||
          !(await verifyPassword(currentPassword.value, current.passwordHash))
        ) {
          throw new ApiException(401, 'wrong_password', 'The current password is wrong.');
        }
        return users.save({
          ...current,
          passwordHash: await hashPassword(password.value),
          sessionVersion: current.sessionVersion + 1,
        });
      });
      return this.hostSession(user);
    });
  }

  async promote(
    caller: User,
    emailInput: unknown,
    passwordInput: unknown,
    hasMembership: (userId: string) => Promise<boolean>,
  ): Promise<GuestSessionResponse> {
    if (!caller.isGuest) {
      throw new ApiException(403, 'not_guest', 'This session is already a host account.');
    }
    const email = parseEmail(emailInput);
    if (!email.ok) throw new ApiException(400, email.error, email.message);
    const password = parsePassword(passwordInput);
    if (!password.ok) throw new ApiException(400, password.error, password.message);

    return this.withPasswordWork(async () => {
      let user: User;
      try {
        user = await this.users.manager.transaction(async (manager) => {
          const users = manager.getRepository(User);
          const current = await this.lockUser(users, caller);
          if (await users.findOneBy({ email: email.value })) {
            throw new ApiException(409, 'email_taken', 'That email is already registered.');
          }
          const membershipActive = new ApiException(
            409,
            'membership_active',
            'Leave the live room before creating a host account.',
          );
          if (await hasMembership(current.id)) throw membershipActive;
          const promoted = await users.save({
            ...current,
            email: email.value,
            passwordHash: await hashPassword(password.value),
            isGuest: false,
            sessionVersion: current.sessionVersion + 1,
          });
          try {
            if (await hasMembership(current.id)) throw membershipActive;
          } catch (error: unknown) {
            try {
              await users.save({
                ...promoted,
                email: current.email,
                passwordHash: current.passwordHash,
                isGuest: current.isGuest,
                sessionVersion: current.sessionVersion,
              });
            } catch {
              throw new ApiException(
                503,
                'server_busy',
                'Account sign-in is busy. Try again shortly.',
              );
            }
            throw error;
          }
          return promoted;
        });
      } catch (error: unknown) {
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === '23505'
        ) {
          throw new ApiException(409, 'email_taken', 'That email is already registered.');
        }
        throw error;
      }
      return this.hostSession(user);
    });
  }

  // Serialize credential changes and reject a request authenticated before another change.
  // The transaction also rolls back promotion if Redis or the explicit restore fails.
  private async lockUser(users: Repository<User>, caller: User): Promise<User> {
    const user = await users
      .createQueryBuilder('user')
      .addSelect('user.passwordHash')
      .where('user.id = :id', { id: caller.id })
      .setLock('pessimistic_write')
      .getOne();
    if (!user || user.sessionVersion !== caller.sessionVersion || user.isGuest !== caller.isGuest) {
      throw new ApiException(401, 'unauthorized', 'Sign in before changing this account.');
    }
    return user;
  }

  private async hostSession(user: User): Promise<GuestSessionResponse> {
    const token = await this.jwt.signAsync(
      { sub: user.id, sv: user.sessionVersion, guest: false },
      { expiresIn: '7d' },
    );
    return { token, userId: user.id, displayName: user.displayName };
  }

  private dummyHash(): Promise<string> {
    this.dummyPasswordHash ??= hashPassword('stageflow-missing-account').catch((error: unknown) => {
      this.dummyPasswordHash = undefined;
      throw error;
    });
    return this.dummyPasswordHash;
  }

  private async withPasswordWork<T>(work: () => Promise<T>): Promise<T> {
    if (this.pendingPasswords >= env.GUEST_PENDING_LIMIT) {
      throw new ApiException(503, 'server_busy', 'Account sign-in is busy. Try again shortly.');
    }
    this.pendingPasswords++;
    try {
      return await work();
    } catch (error: unknown) {
      if (error instanceof ApiException) throw error;
      throw new ApiException(503, 'server_busy', 'Account sign-in is busy. Try again shortly.');
    } finally {
      this.pendingPasswords--;
    }
  }
}
