import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { env } from './config/env';
import { AppModule } from './app.module';
import { ApiExceptionFilter } from './http/api-exception.filter';
import { IoAdapter } from '@nestjs/platform-socket.io';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api');
  app.useWebSocketAdapter(new IoAdapter(app));
  app.useGlobalFilters(new ApiExceptionFilter());
  app.enableCors({
    origin: env.CORS_ORIGIN,
    methods: ['GET', 'POST'],
    allowedHeaders: ['Authorization', 'Content-Type'],
  });
  app.enableShutdownHooks();
  await app.listen(env.PORT);
}

void bootstrap().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'API startup failed.');
  process.exit(1);
});
