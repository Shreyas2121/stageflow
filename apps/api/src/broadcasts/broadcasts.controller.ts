import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Next,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { BroadcastResponse } from '@stageflow/shared';
import type { NextFunction, Response } from 'express';
import { JwtAuthGuard } from '../sessions/jwt-auth.guard';
import { CurrentUser } from '../sessions/current-user.decorator';
import { User } from '../users/user.entity';
import { ApiException } from '../http/api.exception';
import { hlsHeaders } from './hls-path';
import { BroadcastsService, type BroadcastPage } from './broadcasts.service';

@Controller()
@UseGuards(JwtAuthGuard)
export class BroadcastsController {
  constructor(private readonly broadcasts: BroadcastsService) {}

  @Get('rooms/:slug/broadcasts')
  list(
    @Param('slug') slug: string,
    @CurrentUser() user: User,
    @Query() query: Record<string, unknown>,
  ): Promise<BroadcastPage> {
    return this.broadcasts.listByRoomSlug(slug, query, user);
  }

  @Get('broadcasts/:id')
  get(@Param('id') id: string, @CurrentUser() user: User): Promise<BroadcastResponse> {
    return this.broadcasts.getById(id, user);
  }

  @Post('broadcasts/:id/visibility')
  @HttpCode(200)
  visibility(
    @Param('id') id: string,
    @CurrentUser() user: User,
    @Body() body: unknown,
  ): Promise<BroadcastResponse> {
    return this.broadcasts.setVisibility(id, user, body);
  }

  @Delete('broadcasts/:id')
  @HttpCode(204)
  delete(@Param('id') id: string, @CurrentUser() user: User): Promise<void> {
    return this.broadcasts.deleteReplay(id, user);
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
    @CurrentUser() user: User,
    @Res() response: Response,
    @Next() next: NextFunction,
  ): Promise<void> {
    const path = await this.broadcasts.mediaPath(id, file, user);
    response.sendFile(path, { headers: hlsHeaders(file), cacheControl: false }, (error) => {
      if (error) next(error);
    });
  }

  @Get('broadcasts/:id/thumbnail.jpg')
  async thumbnail(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Res() response: Response,
    @Next() next: NextFunction,
  ): Promise<void> {
    const path = await this.broadcasts.thumbnailFile(id, user);
    response.sendFile(
      path,
      {
        headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private' },
        cacheControl: false,
      },
      (error) => {
        if (error) next(error);
      },
    );
  }
}
