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
      useFactory: (repository: Repository<Broadcast>, rooms: RoomsService) =>
        new BroadcastsService(repository, rooms),
    },
  ],
  exports: [BroadcastsService],
})
export class BroadcastsModule {}
