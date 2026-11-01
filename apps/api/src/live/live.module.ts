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

@Module({
  imports: [SessionsModule, RoomsModule],
  controllers: [LiveReadinessController],
  providers: [
    {
      provide: LiveConnection,
      useFactory: () => new LiveConnection(),
    },
    {
      provide: LiveRepository,
      inject: [LiveConnection],
      useFactory: (connection: LiveConnection) => new LiveRepository(connection.client),
    },
    SerializedOperations,
    {
      provide: LiveService,
      inject: [RoomsService, LiveRepository, SerializedOperations, LiveConnection],
      useFactory: (
        rooms: RoomsService,
        live: LiveRepository,
        operations: SerializedOperations,
        connection: LiveConnection,
      ) => new LiveService(rooms, live, operations, connection),
    },
    SignalingGateway,
  ],
  exports: [LiveConnection],
})
export class LiveModule {}
