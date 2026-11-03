import { expect, it, vi } from 'vitest';
import type { ArgumentsHost } from '@nestjs/common';
import { ApiExceptionFilter } from './api-exception.filter';
import { ApiException } from './api.exception';

it('sets Retry-After only for a rate limit that names its window', () => {
  const response = {
    setHeader: vi.fn(),
    status: vi.fn(),
    json: vi.fn(),
  };
  response.status.mockReturnValue(response);
  const host = {
    switchToHttp: () => ({ getResponse: () => response }),
  } as unknown as ArgumentsHost;
  new ApiExceptionFilter().catch(
    new ApiException(429, 'rate_limited', 'Too many requests. Try again shortly.', 60),
    host,
  );
  expect(response.setHeader).toHaveBeenCalledExactlyOnceWith('Retry-After', '60');
  expect(response.status).toHaveBeenCalledWith(429);
  response.setHeader.mockClear();
  new ApiExceptionFilter().catch(
    new ApiException(403, 'not_host', 'Only the host can upload chunks.'),
    host,
  );
  expect(response.setHeader).not.toHaveBeenCalled();
  expect(response.status).toHaveBeenCalledWith(403);
});
