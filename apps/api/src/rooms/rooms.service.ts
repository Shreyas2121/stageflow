import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { createRoomSlugFromCrypto, parseRoomMode, parseRoomTitle } from '@stageflow/shared';
import type { RoomResponse } from '@stageflow/shared';
import { User } from '../users/user.entity';
import { ApiException } from '../http/api.exception';
import { Room } from './room.entity';

@Injectable()
export class RoomsService {
  constructor(@InjectRepository(Room) private readonly rooms: Repository<Room>) {}

  async getById(id: string): Promise<Room | null> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;
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
    if (!/^[A-Za-z0-9]{12}$/.test(slug)) throw notFound;
    const room = await this.rooms.findOne({ where: { slug }, relations: { host: true } });
    if (!room) throw notFound;
    return {
      id: room.id,
      slug: room.slug,
      title: room.title,
      mode: room.mode,
      status: room.status,
      hostId: room.hostId,
      hostDisplayName: room.host.displayName,
      createdAt: room.createdAt.toISOString(),
      endedAt: room.endedAt?.toISOString() ?? null,
    };
  }
}
