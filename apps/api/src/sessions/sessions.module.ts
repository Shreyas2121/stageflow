import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { env } from '../config/env';
import { User } from '../users/user.entity';
import { SessionsController } from './sessions.controller';
import { SessionsService } from './sessions.service';
import { JwtAuthGuard } from './jwt-auth.guard';

@Module({
  imports: [
    TypeOrmModule.forFeature([User]),
    JwtModule.register({
      secret: env.JWT_SECRET,
      signOptions: { algorithm: 'HS256', expiresIn: '12h' },
    }),
  ],
  controllers: [SessionsController],
  providers: [SessionsService, JwtAuthGuard],
  exports: [SessionsService, JwtAuthGuard, JwtModule, TypeOrmModule],
})
export class SessionsModule {}
