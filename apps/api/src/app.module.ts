import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { env } from './config/env';
import { apiConfigSchema } from './config/parse-config';
import { databaseOptions } from './database/data-source';
import { SessionsModule } from './sessions/sessions.module';
import { RoomsModule } from './rooms/rooms.module';
import { HealthController } from './health/health.controller';
import { LiveModule } from './live/live.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      ignoreEnvFile: true,
      validationSchema: apiConfigSchema,
      load: [() => env],
    }),
    TypeOrmModule.forRoot({
      ...databaseOptions,
      extra: { connectionTimeoutMillis: 3000, statement_timeout: 5000, query_timeout: 6000 },
    }),
    SessionsModule,
    RoomsModule,
    LiveModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
