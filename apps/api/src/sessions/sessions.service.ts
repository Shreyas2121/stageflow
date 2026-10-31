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

  async createGuest(input: unknown): Promise<GuestSessionResponse> {
    const parsed = parseDisplayName(input);
    if (!parsed.ok) throw new ApiException(400, parsed.error, parsed.message);
    const user = await this.users.save(this.users.create({ displayName: parsed.value, isGuest: true }));
    const token = await this.jwt.signAsync({ sub: user.id });
    return { token, userId: user.id, displayName: user.displayName };
  }
}
