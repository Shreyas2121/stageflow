import type { RequestHandler } from 'express';
import type { ApiConfig } from '../config/parse-config';
import { networkIdentity } from './network-identity';
import { retryAfterSeconds, WindowBudget } from './window-budget';

export type HttpTrafficClass = 'exempt' | 'control' | 'media' | 'upload';

const GUEST_SESSION_PATHS = new Set([
  '/api/sessions/guest',
  '/api/sessions/register',
  '/api/sessions/login',
]);

// HLS reads and chunk posts do not spend the ordinary API budget. Playback on a
// shared localhost or NAT address cannot exhaust the producer allowance.
export function httpTrafficClass(method: string, path: string): HttpTrafficClass {
  const normalized =
    path
      .toLowerCase()
      .replace(/[?#].*$/, '')
      .replace(/\/+$/, '') || '/';
  if (
    !normalized.startsWith('/api/') ||
    method === 'OPTIONS' ||
    (method === 'GET' && (normalized === '/api/health' || normalized === '/api/health/live'))
  )
    return 'exempt';
  if (method === 'GET' && /^\/api\/broadcasts\/[^/]+\/hls\/[^/]+$/.test(normalized)) return 'media';
  if (method === 'POST' && /^\/api\/broadcasts\/[^/]+\/chunks$/.test(normalized)) return 'upload';
  return 'control';
}

export function httpAdmission(config: ApiConfig): RequestHandler {
  const control = new WindowBudget(
    config.HTTP_RATE_LIMIT,
    config.RATE_WINDOW_MS,
    config.RATE_KEYS_MAX,
  );
  const guests = new WindowBudget(
    config.GUEST_RATE_LIMIT,
    config.RATE_WINDOW_MS,
    config.RATE_KEYS_MAX,
  );
  const media = new WindowBudget(
    config.HLS_RATE_LIMIT,
    config.RATE_WINDOW_MS,
    config.RATE_KEYS_MAX,
  );
  const uploads = new WindowBudget(
    config.UPLOAD_NETWORK_RATE_LIMIT,
    config.RATE_WINDOW_MS,
    config.RATE_KEYS_MAX,
  );
  return (request, response, next) => {
    const traffic = httpTrafficClass(request.method, request.path);
    if (traffic === 'exempt') {
      next();
      return;
    }
    const identity = networkIdentity(request, config.TRUSTED_PROXIES);
    const path = request.path.toLowerCase().replace(/\/+$/, '') || '/';
    let rejected: WindowBudget | null = null;
    if (traffic === 'media') {
      if (!media.consume(identity)) rejected = media;
    } else if (traffic === 'upload') {
      if (!uploads.consume(identity)) rejected = uploads;
    } else if (!control.consume(identity)) rejected = control;
    else if (
      request.method === 'POST' &&
      GUEST_SESSION_PATHS.has(path) &&
      !guests.consume(identity)
    )
      rejected = guests;
    if (rejected) {
      response.setHeader('Retry-After', String(retryAfterSeconds(rejected.blockedForMs(identity))));
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
