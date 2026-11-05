import { Module } from '@nestjs/common';
import { LiveModule } from '../live/live.module';
import { AccountsController } from './accounts.controller';
import { SessionsModule } from './sessions.module';
import { GoogleController } from './google.controller';
import { GOOGLE_CONFIG, GOOGLE_EXCHANGE, GOOGLE_STATE, RedisGoogleState } from './google-state';
import { createGoogleExchange } from './google-exchange';
import { env } from '../config/env';

@Module({
  imports: [SessionsModule, LiveModule],
  controllers: [AccountsController, GoogleController],
  providers: [
    { provide: GOOGLE_CONFIG, useValue: env },
    { provide: GOOGLE_EXCHANGE, useFactory: () => createGoogleExchange(env) },
    { provide: GOOGLE_STATE, useFactory: () => new RedisGoogleState() },
  ],
})
export class AccountsModule {}
