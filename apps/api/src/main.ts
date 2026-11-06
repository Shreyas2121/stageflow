import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { env } from './config/env';
import { AppModule } from './app.module';
import { bindLiveResetExit, LiveConnection } from './live/live.connection';
import { ApiExceptionFilter } from './http/api-exception.filter';
import { IoAdapter } from '@nestjs/platform-socket.io';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { httpAdmission, httpPreflight } from './admission/http-admission';
import { normalizeAddress } from './config/parse-config';
import { broadcastChunkParser } from './broadcasts/chunk-parser';
import { bindDevShutdown } from './dev-shutdown';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
  app.set('trust proxy', (address: string) =>
    env.TRUSTED_PROXIES.includes(normalizeAddress(address)),
  );
  app.getHttpAdapter().enableCors({
    origin: env.CORS_ORIGIN,
    credentials: true,
    preflightContinue: true,
    methods: ['GET', 'POST', 'DELETE'],
    allowedHeaders: ['Authorization', 'Content-Type', 'x-chunk-sequence'],
    exposedHeaders: ['Retry-After'],
  });
  app.use(httpAdmission(env));
  app.use(httpPreflight);
  app.use('/api/broadcasts/:id/chunks', broadcastChunkParser);
  app.useBodyParser('json', { limit: env.HTTP_BODY_BYTES });
  app.setGlobalPrefix('api');
  app.useWebSocketAdapter(new IoAdapter(app));
  app.useGlobalFilters(new ApiExceptionFilter());
  app.enableShutdownHooks();
  // The channel is open before the process acquires the owner guard, so a dev restart can
  // close Nest instead of force-killing a process that has not released ownership.
  await bindDevShutdown(async () => {
    await app.close();
    process.exit(0);
  });
  await app.listen(env.PORT, env.HOST);
  // Redis loss exits after sockets are dropped. A PostgreSQL health failure must not exit.
  bindLiveResetExit(app.get(LiveConnection), (code) => process.exit(code));
}

void bootstrap().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'API startup failed.');
  process.exit(1);
});
