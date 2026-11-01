import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { LiveConnection } from './live.connection';

@Controller('health/live')
export class LiveReadinessController {
  constructor(private readonly connection: LiveConnection) {}

  @Get()
  get(): { ok: true } {
    if (!this.connection.isReady()) throw new ServiceUnavailableException({ ok: false });
    return { ok: true };
  }
}
