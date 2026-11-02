import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../sessions/jwt-auth.guard';
import { BroadcastsService, type BroadcastCatalog } from './broadcasts.service';

@Controller()
@UseGuards(JwtAuthGuard)
export class BroadcastsController {
  constructor(private readonly broadcasts: BroadcastsService) {}

  @Get('rooms/:slug/broadcasts')
  list(@Param('slug') slug: string): Promise<BroadcastCatalog[]> {
    return this.broadcasts.listByRoomSlug(slug);
  }

  @Get('broadcasts/:id')
  get(@Param('id') id: string): Promise<BroadcastCatalog> {
    return this.broadcasts.getById(id);
  }
}
