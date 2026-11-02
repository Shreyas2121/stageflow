import type { RequestHandler } from 'express';
import type { ApiConfig } from '../config/parse-config';
import { networkIdentity } from './network-identity';
import { WindowBudget } from './window-budget';

export function httpAdmission(config: ApiConfig): RequestHandler {
  const requests = new WindowBudget(
    config.HTTP_RATE_LIMIT,
    config.RATE_WINDOW_MS,
    config.RATE_KEYS_MAX,
  );
  const guests = new WindowBudget(
    config.GUEST_RATE_LIMIT,
    config.RATE_WINDOW_MS,
    config.RATE_KEYS_MAX,
  );
  return (request, response, next) => {
    const path = request.path.toLowerCase().replace(/\/+$/, '');
    if (
      !path.startsWith('/api/') ||
      (request.method === 'GET' && (path === '/api/health' || path === '/api/health/live')) ||
      request.method === 'OPTIONS'
    ) {
      next();
      return;
    }
    const identity = networkIdentity(request, config.TRUSTED_PROXIES);
    if (
      !requests.consume(identity) ||
      (request.method === 'POST' && path === '/api/sessions/guest' && !guests.consume(identity))
    ) {
      response.setHeader('Retry-After', Math.ceil(config.RATE_WINDOW_MS / 1000));
      response.status(429).json({
        statusCode: 429,
        error: 'rate_limited',
        message: 'Too many requests. Try again shortly.',
      });
      return;
    }
    if (request.headers.origin && request.headers.origin !== config.CORS_ORIGIN) {
      response.status(403).json({
        statusCode: 403,
        error: 'origin_not_allowed',
        message: 'This origin is not allowed.',
      });
      return;
    }
    next();
  };
}
