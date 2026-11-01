const requiredKeys = ['JWT_SECRET', 'DATABASE_URL', 'REDIS_URL', 'CORS_ORIGIN'] as const;
const missingKeys = requiredKeys.filter((key) => !process.env[key]?.trim());
if (missingKeys.length > 0) {
  throw new Error(`Missing environment variables: ${missingKeys.join(', ')}`);
}
if ((process.env.JWT_SECRET?.length ?? 0) < 16) {
  throw new Error('JWT_SECRET must contain at least 16 characters.');
}

export const env = {
  PORT: Number(process.env.PORT || 4000),
  NODE_ENV: process.env.NODE_ENV || 'development',
  JWT_SECRET: process.env.JWT_SECRET!,
  DATABASE_URL: process.env.DATABASE_URL!,
  REDIS_URL: process.env.REDIS_URL!,
  CORS_ORIGIN: process.env.CORS_ORIGIN!,
  STUN_URL: process.env.STUN_URL?.trim() ?? '',
  TURN_URL: process.env.TURN_URL?.trim() ?? '',
  TURN_USERNAME: process.env.TURN_USERNAME?.trim() ?? '',
  TURN_CREDENTIAL: process.env.TURN_CREDENTIAL?.trim() ?? '',
};
