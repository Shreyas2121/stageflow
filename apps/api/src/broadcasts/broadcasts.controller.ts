import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Next,
  Param,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { NextFunction, Response } from 'express';
import { JwtAuthGuard } from '../sessions/jwt-auth.guard';
import { CurrentUser } from '../sessions/current-user.decorator';
import { User } from '../users/user.entity';
import { ApiException } from '../http/api.exception';
import { hlsHeaders } from './hls-path';
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

  @Post('broadcasts/:id/chunks')
  @HttpCode(204)
  upload(
    @Param('id') id: string,
    @CurrentUser() user: User,
    @Headers('x-chunk-sequence') sequence: string | undefined,
    @Headers('content-type') contentType: string | undefined,
    @Body() body: unknown,
  ): Promise<void> {
    if (
      !sequence ||
      !/^(0|[1-9]\d*)$/.test(sequence) ||
      contentType?.split(';')[0]?.trim().toLowerCase() !== 'application/octet-stream' ||
      !Buffer.isBuffer(body)
    )
      throw new ApiException(
        400,
        'invalid_chunk',
        'Send an octet-stream body and a non-negative integer x-chunk-sequence.',
      );
    return this.broadcasts.upload(id, user.id, Number(sequence), body);
  }

  @Get('broadcasts/:id/hls/:file')
  async media(
    @Param('id') id: string,
    @Param('file') file: string,
    @Res() response: Response,
    @Next() next: NextFunction,
  ): Promise<void> {
    const path = await this.broadcasts.mediaPath(id, file);
    response.sendFile(path, { headers: hlsHeaders(file), cacheControl: false }, (error) => {
      if (error) next(error);
    });
  }
}
