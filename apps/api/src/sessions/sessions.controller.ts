import { Body, Controller, Post } from '@nestjs/common';
import { SessionsService } from './sessions.service';
import type { GuestSessionResponse } from '@stageflow/shared';

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
}
