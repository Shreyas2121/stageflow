import { ArgumentsHost, Catch } from '@nestjs/common';
import type { ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import { ApiException } from './api.exception';

@Catch(ApiException)
export class ApiExceptionFilter implements ExceptionFilter<ApiException> {
  catch(exception: ApiException, host: ArgumentsHost): void {
    host.switchToHttp().getResponse<Response>()
      .status(exception.getStatus()).json(exception.getResponse());
  }
}
