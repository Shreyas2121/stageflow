import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { DataSource } from 'typeorm';

// PostgreSQL liveness only. Redis loss stays on GET /api/health/live and must not change this body.
@Controller('health')
export class HealthController {
  constructor(private readonly database: DataSource) {}

  @Get()
  async get(): Promise<{ ok: true }> {
    try {
      await this.database.query('SELECT 1');
      return { ok: true };
    } catch {
      throw new ServiceUnavailableException({ ok: false });
    }
  }
}
