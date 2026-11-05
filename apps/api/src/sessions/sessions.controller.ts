import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { SessionsService } from './sessions.service';
import type { GuestSessionResponse } from '@stageflow/shared';
import { User } from '../users/user.entity';
import { CurrentUser } from './current-user.decorator';
import { JwtAuthGuard } from './jwt-auth.guard';

function accountBody(body: unknown): Record<string, unknown> {
  return typeof body === 'object' && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

@Controller('sessions')
export class SessionsController {
  constructor(private readonly sessions: SessionsService) {}

  @Post('guest')
  createGuest(@Body() body: unknown): Promise<GuestSessionResponse> {
    const displayName =
      typeof body === 'object' && body !== null && 'displayName' in body
        ? body.displayName
        : undefined;
    return this.sessions.createGuest(displayName);
  }

  @Post('register')
  register(@Body() body: unknown): Promise<GuestSessionResponse> {
    const fields = accountBody(body);
    return this.sessions.register(fields.displayName, fields.email, fields.password);
  }

  @Post('login')
  login(@Body() body: unknown): Promise<GuestSessionResponse> {
    const fields = accountBody(body);
    return this.sessions.login(fields.email, fields.password);
  }

  @Post('password')
  @UseGuards(JwtAuthGuard)
  changePassword(@CurrentUser() user: User, @Body() body: unknown): Promise<GuestSessionResponse> {
    const fields = accountBody(body);
    return this.sessions.changePassword(user, fields.currentPassword, fields.password);
  }
}
