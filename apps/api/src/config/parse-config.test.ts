import { describe, expect, it } from 'vitest';
import { apiConfigSchema, databaseSchema, parseConfig, parseDatabaseConfig } from './parse-config';

const valid = {
  JWT_SECRET: 'test-secret-with-enough-length',
  DATABASE_URL: 'postgresql://test:test@localhost/test',
  REDIS_URL: 'redis://localhost:6379',
  CORS_ORIGIN: 'http://localhost:5173',
};
it('validates through one Zod schema and infers parsed defaults', () => {
  const parsed = apiConfigSchema.parse({
    ...valid,
    PORT: '4567',
    TRUSTED_PROXIES: '127.0.0.1, ::1',
  });
  expect(parsed.PORT).toBe(4567);
  expect(parsed.TRUSTED_PROXIES).toEqual(['127.0.0.1', '::1']);
  expect(parsed.HOST).toBe('127.0.0.1');
  expect(parsed.LIVE_PENDING_LIMIT).toBe(512);
  expect(parsed.HTTP_BODY_BYTES).toBe(16384);
  expect(parsed.HLS_RATE_LIMIT).toBe(240);
  expect(parsed.UPLOAD_NETWORK_RATE_LIMIT).toBe(240);
  expect(parsed.UPLOAD_USER_RATE_LIMIT).toBe(240);
  expect(parsed.UPLOAD_ATTEMPT_RATE_LIMIT).toBe(240);
  expect(parsed.LIVE_NAMESPACE).toBe('sf_development');
  expect(parseConfig({ ...valid, NODE_ENV: 'test' }).LIVE_NAMESPACE).toBe('sf_test');
});
describe('invalid configuration', () => {
  it.each([
    ['PORT', 'NaN'],
    ['PORT', '-1'],
    ['PORT', '65536'],
    ['PORT', ''],
    ['PORT', '1.2'],
    ['PORT', '1e3'],
    ['DATABASE_URL', 'http://localhost/db'],
    ['REDIS_URL', 'http://localhost'],
    ['CORS_ORIGIN', '*'],
    ['CORS_ORIGIN', 'http://localhost/'],
    ['CORS_ORIGIN', 'https://a/path'],
    ['CORS_ORIGIN', 'https://user:password@a'],
    ['TRUSTED_PROXIES', 'true'],
    ['TRUSTED_PROXIES', '127.0.0.0/8'],
    ['HOST', 'localhost'],
    ['LIVE_NAMESPACE', 'other:*'],
    ['GUEST_RATE_LIMIT', '0'],
    ['HLS_RATE_LIMIT', '0'],
    ['UPLOAD_ATTEMPT_RATE_LIMIT', '100001'],
    ['LIVE_PENDING_LIMIT', 'Infinity'],
    ['STUN_URL', 'https://example.org'],
    ['TURN_URL', 'turn:example.org:99999'],
  ])('rejects %s=%s with a field-specific diagnostic', (key, value) => {
    expect(() => parseConfig({ ...valid, [key]: value })).toThrow(key);
  });
});
it('requires complete TURN credentials and rejects placeholder production secrets', () => {
  expect(() => parseConfig({ ...valid, TURN_URL: 'turn:relay.example.org:3478' })).toThrow(
    'TURN_URL',
  );
  expect(() => parseConfig({ ...valid, TURN_USERNAME: 'u' })).toThrow('TURN_URL');
  expect(
    parseConfig({
      ...valid,
      TURN_URL: 'turns:relay.example.org:5349?transport=tcp',
      TURN_USERNAME: 'u',
      TURN_CREDENTIAL: 'p',
    }).TURN_USERNAME,
  ).toBe('u');
  expect(() => parseConfig({ ...valid, NODE_ENV: 'production' })).toThrow('JWT_SECRET');
  expect(() =>
    parseConfig({
      ...valid,
      NODE_ENV: 'production',
      JWT_SECRET: 'stageflow-placeholder-secret-with-32-characters',
    }),
  ).toThrow('JWT_SECRET');
  expect(
    parseConfig({
      ...valid,
      NODE_ENV: 'production',
      JWT_SECRET: '4c5be909fcae68060cdaeb92e15eaf67d51b74f2c5e0f031',
    }).NODE_ENV,
  ).toBe('production');
});
it('keeps migrations database-only and never includes secret values in diagnostics', () => {
  expect(databaseSchema.parse({ DATABASE_URL: valid.DATABASE_URL })).toEqual({
    DATABASE_URL: valid.DATABASE_URL,
  });
  expect(parseDatabaseConfig({ DATABASE_URL: valid.DATABASE_URL, JWT_SECRET: 'invalid' })).toEqual({
    DATABASE_URL: valid.DATABASE_URL,
  });
  const secretUrl = 'http://private-user:private-password@localhost/db';
  try {
    parseDatabaseConfig({ DATABASE_URL: secretUrl });
    throw new Error('Should reject');
  } catch (error) {
    expect(String(error)).toContain('DATABASE_URL');
    expect(String(error)).not.toContain('private-password');
  }
});
