import { createServer } from 'node:http';
import type { Express } from 'express';
import { ExpressAdapter } from '@nestjs/platform-express';
import { expect, it } from 'vitest';
import { httpAdmission } from './http-admission';
import { parseConfig } from '../config/parse-config';

async function fixture(test: (url: string, writes: () => number) => Promise<void>) {
  const config = parseConfig({
    JWT_SECRET: 'test-secret-with-enough-length',
    DATABASE_URL: 'postgresql://test:test@localhost/test',
    REDIS_URL: 'redis://localhost',
    CORS_ORIGIN: 'http://allowed.test',
    GUEST_RATE_LIMIT: '2',
    HTTP_RATE_LIMIT: '10',
    HTTP_BODY_BYTES: '1024',
  });
  const adapter = new ExpressAdapter();
  const app = adapter.getInstance() as Express;
  let writes = 0;
  adapter.enableCors({ origin: config.CORS_ORIGIN });
  app.use(httpAdmission(config));
  adapter.useBodyParser('json', false, { limit: config.HTTP_BODY_BYTES });
  app.post('/api/sessions/guest', (_request, response) => {
    writes++;
    response.json({ ok: true });
  });
  app.get('/api/health', (_request, response) => {
    response.json({ ok: true });
  });
  app.get('/api/rooms/example', (_request, response) => {
    response.json({ ok: true });
  });
  const server = createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No HTTP test port.');
  try {
    await test(`http://127.0.0.1:${address.port}`, () => writes);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}
it('limits actual guest requests before writes, including case/trailing-slash aliases and spoofed headers', async () => {
  await fixture(async (url, writes) => {
    for (const [path, status] of [
      ['/api/sessions/guest', 200],
      ['/API/sessions/guest/', 200],
      ['/api/sessions/guest', 429],
    ] as const) {
      const response = await fetch(url + path, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Forwarded-For': `10.0.0.${status}`,
          Origin: 'http://allowed.test',
        },
        body: '{}',
      });
      expect(response.status).toBe(status);
      if (status === 429) {
        expect(response.headers.get('retry-after')).toBe('60');
        expect(response.headers.get('access-control-allow-origin')).toBe('http://allowed.test');
        expect(await response.json()).toMatchObject({ error: 'rate_limited' });
      } else await response.text();
    }
    expect(writes()).toBe(2);
    expect((await fetch(url + '/api/health')).status).toBe(200);
  });
});
it('rejects oversized JSON and unwanted origins before a guest write; normal API work has its own budget', async () => {
  await fixture(async (url, writes) => {
    const oversized = await fetch(url + '/api/sessions/guest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: 'x'.repeat(2000) }),
    });
    expect(oversized.status).toBe(413);
    await oversized.text();
    const origin = await fetch(url + '/api/sessions/guest', {
      method: 'POST',
      headers: { Origin: 'http://other.test' },
    });
    expect(origin.status).toBe(403);
    await origin.text();
    expect(writes()).toBe(0);
    for (let index = 0; index < 8; index++) {
      const response = await fetch(url + '/api/rooms/example');
      expect(response.status).toBe(200);
      await response.text();
    }
    const limited = await fetch(url + '/api/rooms/example');
    expect(limited.status).toBe(429);
    await limited.text();
    expect((await fetch(url + '/api/health')).status).toBe(200);
  });
});
