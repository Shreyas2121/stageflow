import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import type { GuestSessionResponse } from '@stageflow/shared';
import { LiveConnection } from '../live/live.connection';
import { User } from '../users/user.entity';
import { CurrentUser } from './current-user.decorator';
import { JwtAuthGuard } from './jwt-auth.guard';
import { SessionsService } from './sessions.service';

@Controller('sessions')
@UseGuards(JwtAuthGuard)
export class AccountsController {
  constructor(
    private readonly sessions: SessionsService,
    private readonly live: LiveConnection,
  ) {}

  @Post('promote')
  promote(@CurrentUser() user: User, @Body() body: unknown): Promise<GuestSessionResponse> {
    const fields =
      typeof body === 'object' && body !== null && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : {};
    return this.sessions.promote(user, fields.email, fields.password, (userId) =>
      this.live.hasUserMembership(userId),
    );
  }
}
