import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import type { RoomResponse } from '@stageflow/shared';
import { User } from '../users/user.entity';
import { CurrentUser } from '../sessions/current-user.decorator';
import { JwtAuthGuard } from '../sessions/jwt-auth.guard';
import { RoomsService } from './rooms.service';

@Controller('rooms')
@UseGuards(JwtAuthGuard)
export class RoomsController {
  constructor(private readonly rooms: RoomsService) {}

  @Post()
  create(@CurrentUser() user: User, @Body() body: unknown): Promise<RoomResponse> {
    return this.rooms.create(user, body);
  }

  @Get(':slug')
  get(@Param('slug') slug: string): Promise<RoomResponse> {
    return this.rooms.getBySlug(slug);
  }
}
