import { isIP } from 'node:net';
import { z } from 'zod';

const integer = (fallback: number, min: number, max: number) =>
  z
    .string()
    .regex(/^\d+$/, 'Must be an integer string.')
    .transform(Number)
    .pipe(z.number().int().min(min).max(max))
    .default(fallback);
const serviceUrl = (protocol: RegExp) =>
  z
    .string()
    .trim()
    .pipe(z.url({ protocol }))
    .refine((value) => {
      try {
        const parsed = new URL(value);
        return Boolean(parsed.hostname) && !parsed.hash;
      } catch {
        return false;
      }
    }, 'Must have a hostname and no fragment.');
const ip = z.string().refine((value) => Boolean(isIP(value)), 'Must be an IP address.');
const googleRedirectUri = z
  .string()
  .trim()
  .default('')
  .refine((value) => {
    if (!value) return true;
    try {
      const parsed = new URL(value);
      return (
        /^https?:$/.test(parsed.protocol) &&
        (parsed.protocol === 'https:' ||
          ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) &&
        Boolean(parsed.hostname) &&
        !/[?#@]/.test(value) &&
        parsed.pathname === '/api/sessions/google/callback'
      );
    } catch {
      return false;
    }
  }, 'Must be an HTTPS URL (HTTP only on loopback) with no userinfo, query, or fragment and path /api/sessions/google/callback.');
const iceUrl = (protocol: RegExp) =>
  z
    .string()
    .trim()
    .max(2048)
    .default('')
    .refine((value) => {
      if (!value) return true;
      const separator = value.indexOf(':');
      if (!protocol.test(value.slice(0, separator)) || /[\s/#@\\]/.test(value)) return false;
      try {
        const parsed = new URL(`http://${value.slice(separator + 1)}`);
        return (
          Boolean(parsed.hostname) &&
          parsed.port !== '0' &&
          (!parsed.search || /^\?transport=(udp|tcp)$/.test(parsed.search))
        );
      } catch {
        return false;
      }
    }, 'Must be a valid ICE server URL.');

export function normalizeAddress(address: string): string {
  const value = address.toLowerCase();
  if (value.startsWith('::ffff:') && isIP(value.slice(7)) === 4) return value.slice(7);
  if (isIP(value) === 6) {
    const [address, scope] = value.split('%');
    const normalized = new URL(`http://[${address}]/`).hostname.slice(1, -1);
    return scope ? `${normalized}%${scope}` : normalized;
  }
  return value;
}

export const databaseSchema = z.object({ DATABASE_URL: serviceUrl(/^postgres(?:ql)?$/) });
export const apiConfigSchema = databaseSchema
  .extend({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    JWT_SECRET: z.string().trim().min(16).max(4096),
    CORS_ORIGIN: serviceUrl(/^https?$/).refine((value) => {
      try {
        return new URL(value).origin === value;
      } catch {
        return false;
      }
    }, 'Must be one exact HTTP(S) origin with no path, credentials, or trailing slash.'),
    REDIS_URL: serviceUrl(/^rediss?$/),
    GOOGLE_CLIENT_ID: z.string().trim().default(''),
    GOOGLE_CLIENT_SECRET: z.string().trim().default(''),
    GOOGLE_REDIRECT_URI: googleRedirectUri,
    PORT: integer(4000, 1, 65535),
    HOST: ip.default('127.0.0.1'),
    FFMPEG_PATH: z.string().trim().min(1).default('ffmpeg'),
    DATA_ROOT: z.string().trim().min(1).default('apps/api/data'),
    LIVE_NAMESPACE: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,64}$/, 'Use 1 to 64 letters, digits, underscores or hyphens.')
      .optional(),
    TRUSTED_PROXIES: z
      .string()
      .trim()
      .default('')
      .transform((value) => (value ? value.split(',').map((item) => item.trim()) : []))
      .pipe(z.array(ip))
      .transform((values) => values.map(normalizeAddress)),
    STUN_URL: iceUrl(/^stuns?$/),
    TURN_URL: iceUrl(/^turns?$/),
    TURN_USERNAME: z.string().trim().default(''),
    TURN_CREDENTIAL: z.string().trim().default(''),
    RATE_WINDOW_MS: integer(60000, 1000, 3600000),
    RATE_KEYS_MAX: integer(10000, 1, 100000),
    HTTP_RATE_LIMIT: integer(240, 1, 100000),
    HLS_RATE_LIMIT: integer(240, 1, 100000),
    UPLOAD_NETWORK_RATE_LIMIT: integer(240, 1, 100000),
    UPLOAD_USER_RATE_LIMIT: integer(240, 1, 100000),
    UPLOAD_ATTEMPT_RATE_LIMIT: integer(240, 1, 100000),
    GUEST_RATE_LIMIT: integer(20, 1, 100000),
    GUEST_PENDING_LIMIT: integer(64, 1, 10000),
    PASSWORD_WORKER_LIMIT: integer(1, 1, 8),
    PASSWORD_QUEUE_LIMIT: integer(4, 0, 32),
    PASSWORD_ACCOUNT_LIMIT: integer(10, 1, 100),
    SOCKET_CONNECT_RATE_LIMIT: integer(60, 1, 100000),
    SOCKET_EVENT_RATE_LIMIT: integer(600, 1, 100000),
    AUTH_PENDING_LIMIT: integer(64, 1, 10000),
    LIVE_PENDING_LIMIT: integer(512, 1, 100000),
    LIVE_PENDING_PER_KEY: integer(32, 1, 10000),
    LIVE_CLEANUP_RESERVE: integer(128, 1, 10000),
    HTTP_BODY_BYTES: integer(16384, 1024, 1048576),
    SOCKET_MESSAGE_BYTES: integer(524288, 8192, 1048576),
  })
  .superRefine((config, context) => {
    if (
      config.NODE_ENV === 'production' &&
      (config.JWT_SECRET.length < 32 ||
        /stageflow|placeholder|change.?me|example|local-dev/i.test(config.JWT_SECRET))
    ) {
      context.addIssue({
        code: 'custom',
        path: ['JWT_SECRET'],
        message: 'Use at least 32 non-placeholder characters in production.',
      });
    }
    if (
      Boolean(config.GOOGLE_CLIENT_ID) !== Boolean(config.GOOGLE_CLIENT_SECRET) ||
      Boolean(config.GOOGLE_CLIENT_ID) !== Boolean(config.GOOGLE_REDIRECT_URI)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['GOOGLE_CLIENT_ID'],
        message:
          'Configure GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI together.',
      });
    }
    if (
      Boolean(config.TURN_URL) !== Boolean(config.TURN_USERNAME) ||
      Boolean(config.TURN_URL) !== Boolean(config.TURN_CREDENTIAL)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['TURN_URL'],
        message: 'Configure TURN_URL, TURN_USERNAME, and TURN_CREDENTIAL together.',
      });
    }
  })
  .transform((config) => ({
    ...config,
    GOOGLE_ENABLED: Boolean(config.GOOGLE_CLIENT_ID),
    LIVE_NAMESPACE: config.LIVE_NAMESPACE ?? `sf_${config.NODE_ENV}`,
  }));

// Keep startup diagnostics useful without printing environment values/secrets.
function parse<S extends z.ZodType>(schema: S, source: unknown): z.output<S> {
  const result = schema.safeParse(source);
  if (!result.success)
    throw new Error(
      `Invalid configuration: ${result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`,
    );
  return result.data;
}
export const parseConfig = (source: unknown) => parse(apiConfigSchema, source);
export const parseDatabaseConfig = (source: unknown) => parse(databaseSchema, source);
export type ApiConfig = z.infer<typeof apiConfigSchema>;
