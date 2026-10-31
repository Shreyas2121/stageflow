import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { env } from './config/env';
import { databaseOptions } from './database/data-source';
import { SessionsModule } from './sessions/sessions.module';
import { RoomsModule } from './rooms/rooms.module';
import { HealthController } from './health/health.controller';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [() => env] }),
    TypeOrmModule.forRoot(databaseOptions),
    SessionsModule,
    RoomsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
