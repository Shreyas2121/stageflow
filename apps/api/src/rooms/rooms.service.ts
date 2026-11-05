import { beforeHistoryCursor } from '../database/catalog-cursor';
import { isUuid, isRoomSlug } from '@stageflow/shared';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  createRoomSlugFromCrypto,
  encodeHistoryCursor,
  parseCatalogLimit,
  parseHistoryCursor,
  parseRoomMode,
  parseRoomTitle,
} from '@stageflow/shared';
import type { RoomResponse } from '@stageflow/shared';
import { readOrderingInstant } from '../database/ordering-instant';
import { ApiException } from '../http/api.exception';
import { User } from '../users/user.entity';
import { Room } from './room.entity';

export type RoomPage = {
  items: RoomResponse[];
  nextCursor: string | null;
};

@Injectable()
export class RoomsService {
  constructor(@InjectRepository(Room) private readonly rooms: Repository<Room>) {}

  async getById(id: string): Promise<Room | null> {
    if (!isUuid(id)) return null;
    return this.rooms.findOneBy({ id });
  }

  async end(roomId: string): Promise<void> {
    await this.rooms.update(
      { id: roomId, status: 'LIVE' },
      { status: 'ENDED', endedAt: new Date() },
    );
  }

  async create(host: User, body: unknown): Promise<RoomResponse> {
    const title = parseRoomTitle(
      typeof body === 'object' && body !== null && 'title' in body ? body.title : undefined,
    );
    if (!title.ok) throw new ApiException(400, title.error, title.message);
    const mode = parseRoomMode(
      typeof body === 'object' && body !== null && 'mode' in body ? body.mode : undefined,
    );
    if (!mode.ok) throw new ApiException(400, mode.error, mode.message);

    for (let attempt = 0; attempt < 6; attempt += 1) {
      const room = this.rooms.create({
        slug: createRoomSlugFromCrypto(),
        title: title.value,
        mode: mode.value,
        status: 'LIVE',
        scheduledStartAt: null,
        requireAdmission: false,
        hostId: host.id,
        endedAt: null,
      });
      try {
        await this.rooms.insert(room);
        return {
          id: room.id,
          slug: room.slug,
          title: room.title,
          mode: room.mode,
          status: room.status,
          scheduledStartAt: room.scheduledStartAt?.toISOString() ?? null,
          requireAdmission: room.requireAdmission,
          hostId: host.id,
          hostDisplayName: host.displayName,
          createdAt: room.createdAt.toISOString(),
          endedAt: null,
        };
      } catch (error: unknown) {
        if (!(
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === '23505'
        )) {
          throw error;
        }
      }
    }
    throw new ApiException(500, 'slug_exhausted', 'Unable to generate an available room slug.');
  }

  async getBySlug(slug: string): Promise<RoomResponse> {
    const notFound = new ApiException(404, 'room_not_found', 'No room exists for that slug.');
    if (!isRoomSlug(slug)) throw notFound;
    const room = await this.rooms.findOne({ where: { slug }, relations: { host: true } });
    if (!room) throw notFound;
    return this.toResponse(room);
  }

  async listForHost(host: User, query: Record<string, unknown>): Promise<RoomPage> {
    const limit = parseCatalogLimit(query.limit);
    if (!limit.ok) throw new ApiException(400, limit.error, limit.message);
    const cursor = parseHistoryCursor(query.cursor);
    if (!cursor.ok) throw new ApiException(400, cursor.error, cursor.message);

    const rows = await this.rooms.find({
      where: {
        hostId: host.id,
        ...(cursor.value
          ? { id: beforeHistoryCursor(cursor.value.createdAt, cursor.value.id) }
          : {}),
      },
      order: { createdAt: 'DESC', id: 'DESC' },
      take: limit.value + 1,
      relations: { host: true },
    });
    const items = (rows.length > limit.value ? rows.slice(0, limit.value) : rows).map((room) =>
      this.toResponse(room),
    );
    if (rows.length <= limit.value) return { items, nextCursor: null };
    const last = items.at(-1);
    const ordering = last
      ? await readOrderingInstant(
          (sql, parameters) => this.rooms.query(sql, parameters),
          'rooms',
          last.id,
        )
      : null;
    const nextCursor = last && ordering ? encodeHistoryCursor(ordering, last.id) : null;
    if (!nextCursor) throw new ApiException(500, 'server_busy', 'The room page could not be read.');
    return { items, nextCursor };
  }

  private toResponse(room: Room): RoomResponse {
    return {
      id: room.id,
      slug: room.slug,
      title: room.title,
      mode: room.mode,
      status: room.status,
      scheduledStartAt: room.scheduledStartAt?.toISOString() ?? null,
      requireAdmission: room.requireAdmission,
      hostId: room.hostId,
      hostDisplayName: room.host.displayName,
      createdAt: room.createdAt.toISOString(),
      endedAt: room.endedAt?.toISOString() ?? null,
    };
  }
}
