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
import { ChatRepository } from '../chat/chat.repository';
import { ChatService } from '../chat/chat.service';
import { QaRepository } from '../qa/qa.repository';
import { QaService } from '../qa/qa.service';

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
      provide: ChatRepository,
      inject: [LiveConnection],
      useFactory: (connection: LiveConnection) => new ChatRepository(connection.client),
    },
    {
      provide: QaRepository,
      inject: [LiveConnection],
      useFactory: (connection: LiveConnection) => new QaRepository(connection.client),
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
        ChatRepository,
        QaRepository,
      ],
      useFactory: (
        rooms: RoomsService,
        live: LiveRepository,
        operations: SerializedOperations,
        connection: LiveConnection,
        broadcasts: BroadcastsService,
        chat: ChatRepository,
        qa: QaRepository,
      ) =>
        new LiveService(
          rooms,
          live,
          operations,
          connection,
          env.LIVE_NAMESPACE,
          {
            service: broadcasts,
            repository: live,
          },
          undefined,
          chat,
          qa,
        ),
    },
    {
      provide: ChatService,
      inject: [ChatRepository, LiveService],
      useFactory: (repository: ChatRepository, live: LiveService) =>
        new ChatService(repository, live, env.LIVE_NAMESPACE),
    },
    {
      provide: QaService,
      inject: [QaRepository, LiveService],
      useFactory: (repository: QaRepository, live: LiveService) =>
        new QaService(repository, live, env.LIVE_NAMESPACE),
    },
    SignalingGateway,
  ],
  exports: [LiveConnection],
})
export class LiveModule {}
