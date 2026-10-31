import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { User } from '../users/user.entity';
import type { AuthenticatedRequest } from './jwt-auth.guard';

export const CurrentUser = createParamDecorator((_data: unknown, context: ExecutionContext): User =>
  context.switchToHttp().getRequest<AuthenticatedRequest>().user,
);
