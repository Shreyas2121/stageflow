import { ExecutionContext, Injectable } from '@nestjs/common';
import type { CanActivate } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { Request } from 'express';
import { User } from '../users/user.entity';
import { ApiException } from '../http/api.exception';

export type AuthenticatedRequest = Request & { user: User };

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    @InjectRepository(User) private readonly users: Repository<User>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = /^Bearer (\S+)$/i.exec(request.headers.authorization ?? '')?.[1];
    const unauthorized = new ApiException(401, 'unauthorized', 'Sign in as a guest before calling this route.');
    if (!token) throw unauthorized;

    let payload: unknown;
    try {
      payload = await this.jwt.verifyAsync<{ sub?: unknown }>(token, { algorithms: ['HS256'] });
    } catch {
      throw unauthorized;
    }
    if (typeof payload !== 'object' || payload === null || !('sub' in payload) || typeof payload.sub !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(payload.sub)) {
      throw unauthorized;
    }
    const user = await this.users.findOneBy({ id: payload.sub });
    if (!user) throw unauthorized;
    request.user = user;
    return true;
  }
}
