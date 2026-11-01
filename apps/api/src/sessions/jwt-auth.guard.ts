import { ExecutionContext, Injectable } from '@nestjs/common';
import type { CanActivate } from '@nestjs/common';
import type { Request } from 'express';
import { User } from '../users/user.entity';
import { SessionsService } from './sessions.service';

export type AuthenticatedRequest = Request & { user: User };

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly sessions: SessionsService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = /^Bearer (\S+)$/i.exec(request.headers.authorization ?? '')?.[1];
    request.user = await this.sessions.verifyToken(token);
    return true;
  }
}
