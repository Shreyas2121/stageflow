import { Injectable, Logger, Module, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Redis } from 'ioredis';
import { env } from '../config/env';
import { RoomsModule } from '../rooms/rooms.module';
import { SessionsModule } from '../sessions/sessions.module';
import { LiveRepository } from './live.repository';
import { SignalingGateway } from './signaling.gateway';

@Injectable()
export class LiveConnection implements OnModuleInit, OnModuleDestroy {
  readonly redis = new Redis(env.REDIS_URL, {
    lazyConnect: true,
    connectTimeout: 3000,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
  });
  private readonly logger = new Logger(LiveConnection.name);

  constructor() {
    this.redis.on('error', (error: Error) => this.logger.error(`Redis: ${error.message}`));
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.redis.connect();
      await this.redis.ping();
      let cursor = '0';
      do {
        const [next, keys] = await this.redis.scan(cursor, 'MATCH', 'sf:room:*', 'COUNT', 100);
        cursor = next;
        if (keys.length) await this.redis.del(...keys);
      } while (cursor !== '0');
    } catch (error) {
      this.redis.disconnect();
      throw new Error('Redis startup failed; the API will not listen.', { cause: error });
    }
  }

  onModuleDestroy(): void {
    this.redis.disconnect();
  }
}

@Module({
  imports: [SessionsModule, RoomsModule],
  providers: [
    LiveConnection,
    {
      provide: LiveRepository,
      inject: [LiveConnection],
      useFactory: (connection: LiveConnection) => new LiveRepository(connection.redis),
    },
    SignalingGateway,
  ],
})
export class LiveModule {}
