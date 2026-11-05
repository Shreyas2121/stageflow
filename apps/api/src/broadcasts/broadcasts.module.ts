import { Redis } from 'ioredis';
import { env } from '../config/env';
import { roomPrefix } from '../live/live.keys';
import { Module } from '@nestjs/common';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';
import { RoomsService } from '../rooms/rooms.service';
import { RoomsModule } from '../rooms/rooms.module';
import { SessionsModule } from '../sessions/sessions.module';
import { Broadcast } from './broadcast.entity';
import { BroadcastsController } from './broadcasts.controller';
import { BroadcastsService } from './broadcasts.service';

@Module({
  imports: [TypeOrmModule.forFeature([Broadcast]), RoomsModule, SessionsModule],
  controllers: [BroadcastsController],
  providers: [
    {
      provide: BroadcastsService,
      inject: [getRepositoryToken(Broadcast), RoomsService],
      useFactory: (repository: Repository<Broadcast>, rooms: RoomsService) => {
        const redis = new Redis(env.REDIS_URL, {
          lazyConnect: true,
          connectTimeout: 3000,
          commandTimeout: 3000,
          maxRetriesPerRequest: 0,
          retryStrategy: () => null,
        });
        redis.on('error', () => {}); // Reads are awaited and fail closed before claiming a row.
        return new BroadcastsService(repository, rooms, undefined, undefined, undefined, {
          read: async (roomId) => {
            if (redis.status === 'end') await redis.connect();
            return redis.get(`${roomPrefix(roomId, env.LIVE_NAMESPACE)}:broadcast`);
          },
          close: async () => {
            if (redis.status === 'wait' || redis.status === 'end') {
              redis.disconnect();
              return;
            }
            try {
              await redis.quit();
            } finally {
              redis.disconnect();
            }
          },
        });
      },
    },
  ],
  exports: [BroadcastsService],
})
export class BroadcastsModule {}
