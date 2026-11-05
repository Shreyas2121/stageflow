import { Module } from '@nestjs/common';
import { LiveModule } from '../live/live.module';
import { AccountsController } from './accounts.controller';
import { SessionsModule } from './sessions.module';

@Module({
  imports: [SessionsModule, LiveModule],
  controllers: [AccountsController],
})
export class AccountsModule {}
