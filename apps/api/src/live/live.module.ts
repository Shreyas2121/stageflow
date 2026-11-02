import { env } from '../config/env';
import { RoomsService } from '../rooms/rooms.service';
import { LiveConnection } from './live.connection';
import { LiveReadinessController } from './live.readiness.controller';
import { LiveService } from './live.service';
import { SerializedOperations } from './serialized-operations';
import { Module } from '@nestjs/common';
import { RoomsModule } from '../rooms/rooms.module';
import { SessionsModule } from '../sessions/sessions.module';
import { LiveRepository } from './live.repository';
import { SignalingGateway } from './signaling.gateway';
import { BroadcastsModule } from '../broadcasts/broadcasts.module';
import { BroadcastsService } from '../broadcasts/broadcasts.service';

@Module({
  imports: [SessionsModule, RoomsModule, BroadcastsModule],
  controllers: [LiveReadinessController],
  providers: [
    {
      provide: LiveConnection,
      inject: [BroadcastsService],
      useFactory: (broadcasts: BroadcastsService) =>
        new LiveConnection(undefined, env.LIVE_NAMESPACE, () => broadcasts.failInFlight()),
    },
    {
      provide: LiveRepository,
      inject: [LiveConnection],
      useFactory: (connection: LiveConnection) => new LiveRepository(connection.client),
    },
    {
      provide: SerializedOperations,
      useFactory: () =>
        new SerializedOperations({
          maxPending: env.LIVE_PENDING_LIMIT,
          maxPerKey: env.LIVE_PENDING_PER_KEY,
          cleanupReserve: env.LIVE_CLEANUP_RESERVE,
        }),
    },
    {
      provide: LiveService,
      inject: [
        RoomsService,
        LiveRepository,
        SerializedOperations,
        LiveConnection,
        BroadcastsService,
      ],
      useFactory: (
        rooms: RoomsService,
        live: LiveRepository,
        operations: SerializedOperations,
        connection: LiveConnection,
        broadcasts: BroadcastsService,
      ) =>
        new LiveService(rooms, live, operations, connection, env.LIVE_NAMESPACE, {
          service: broadcasts,
          repository: live,
        }),
    },
    SignalingGateway,
  ],
  exports: [LiveConnection],
})
export class LiveModule {}
