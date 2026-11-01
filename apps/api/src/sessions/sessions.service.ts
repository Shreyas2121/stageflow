import { isUuid } from '@stageflow/shared';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { JwtService } from '@nestjs/jwt';
import { Repository } from 'typeorm';
import { parseDisplayName } from '@stageflow/shared';
import type { GuestSessionResponse } from '@stageflow/shared';
import { User } from '../users/user.entity';
import { ApiException } from '../http/api.exception';

@Injectable()
export class SessionsService {
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
      payload = await this.jwt.verifyAsync<{ sub?: unknown }>(token, { algorithms: ['HS256'] });
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
    const user = await this.users.findOneBy({ id: payload.sub });
    if (!user) throw unauthorized;
    return user;
  }

  async createGuest(input: unknown): Promise<GuestSessionResponse> {
    const parsed = parseDisplayName(input);
    if (!parsed.ok) throw new ApiException(400, parsed.error, parsed.message);
    const user = await this.users.save(
      this.users.create({ displayName: parsed.value, isGuest: true }),
    );
    const token = await this.jwt.signAsync({ sub: user.id });
    return { token, userId: user.id, displayName: user.displayName };
  }
}
