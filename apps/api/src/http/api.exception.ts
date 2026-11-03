import { HttpException } from '@nestjs/common';
import type { ApiErrorBody } from '@stageflow/shared';

export class ApiException extends HttpException {
  constructor(
    statusCode: number,
    error: ApiErrorBody['error'],
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super({ statusCode, error, message } satisfies ApiErrorBody, statusCode);
  }
}
