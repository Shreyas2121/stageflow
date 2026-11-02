import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { isUuid } from '@stageflow/shared';
import { In, Repository } from 'typeorm';
import { ApiException } from '../http/api.exception';
import { RoomsService } from '../rooms/rooms.service';
import { Broadcast } from './broadcast.entity';

export type BroadcastCatalog = Pick<
  Broadcast,
  'id' | 'roomId' | 'status' | 'playlistPath' | 'thumbnailPath' | 'errorMessage'
> & { startedAt: string; endedAt: string | null; createdAt: string };

function catalog(row: Broadcast): BroadcastCatalog {
  return {
    id: row.id,
    roomId: row.roomId,
    status: row.status,
    playlistPath: row.playlistPath,
    thumbnailPath: row.thumbnailPath,
    errorMessage: row.errorMessage,
    startedAt: row.startedAt.toISOString(),
    endedAt: row.endedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

@Injectable()
export class BroadcastsService {
  constructor(
    @InjectRepository(Broadcast) private readonly broadcasts: Repository<Broadcast>,
    private readonly rooms: RoomsService,
  ) {}

  async failInFlight(): Promise<void> {
    await this.broadcasts.update(
      { status: In(['STARTING', 'LIVE', 'STOPPING']) },
      { status: 'FAILED', errorMessage: 'api restarted', endedAt: new Date() },
    );
  }

  async listByRoomSlug(slug: string): Promise<BroadcastCatalog[]> {
    const room = await this.rooms.getBySlug(slug);
    const rows = await this.broadcasts.find({
      where: { roomId: room.id },
      order: { createdAt: 'DESC', id: 'DESC' },
    });
    return rows.map(catalog);
  }

  async getById(id: string): Promise<BroadcastCatalog> {
    const notFound = new ApiException(
      404,
      'broadcast_not_found',
      'No broadcast exists for that id.',
    );
    if (!isUuid(id)) throw notFound;
    const row = await this.broadcasts.findOneBy({ id });
    if (!row) throw notFound;
    return catalog(row);
  }
}
