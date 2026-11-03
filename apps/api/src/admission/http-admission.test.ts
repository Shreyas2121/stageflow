import { createServer } from 'node:http';
import type { Express } from 'express';
import { ExpressAdapter } from '@nestjs/platform-express';
import { expect, it } from 'vitest';
import { broadcastChunkParser } from '../broadcasts/chunk-parser';
import { parseConfig } from '../config/parse-config';
import { httpAdmission, httpTrafficClass } from './http-admission';

async function fixture(
  test: (
    url: string,
    activity: { guest: () => number; media: () => number; uploads: () => number },
  ) => Promise<void>,
  source: Record<string, string> = {},
) {
  const config = parseConfig({
    JWT_SECRET: 'test-secret-with-enough-length',
    DATABASE_URL: 'postgresql://test:test@localhost/test',
    REDIS_URL: 'redis://localhost',
    CORS_ORIGIN: 'http://allowed.test',
    GUEST_RATE_LIMIT: '2',
    HTTP_RATE_LIMIT: '10',
    HTTP_BODY_BYTES: '1024',
    ...source,
  });
  const adapter = new ExpressAdapter();
  const app = adapter.getInstance() as Express;
  const activity = { guest: 0, media: 0, uploads: 0 };
  adapter.enableCors({ origin: config.CORS_ORIGIN });
  app.use(httpAdmission(config));
  app.use('/api/broadcasts/:id/chunks', broadcastChunkParser);
  adapter.useBodyParser('json', false, { limit: config.HTTP_BODY_BYTES });
  app.post('/api/sessions/guest', (_request, response) => {
    activity.guest++;
    response.json({ ok: true });
  });
  app.get('/api/health', (_request, response) => {
    response.json({ ok: true });
  });
  app.get('/api/rooms/example', (_request, response) => {
    response.json({ ok: true });
  });
  app.get('/api/broadcasts/:id/hls/:file', (_request, response) => {
    activity.media++;
    response.type('text/plain').send('media');
  });
  app.post('/api/broadcasts/:id/chunks', (_request, response) => {
    activity.uploads++;
    response.status(204).end();
  });
  const server = createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No HTTP test port.');
  try {
    await test(`http://127.0.0.1:${address.port}`, {
      guest: () => activity.guest,
      media: () => activity.media,
      uploads: () => activity.uploads,
    });
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
    expect(writes.guest()).toBe(2);
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
    expect(writes.guest()).toBe(0);
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
it('classifies HLS reads, chunk posts, and ordinary requests separately', () => {
  expect(httpTrafficClass('GET', '/API/broadcasts/abc/hls/Index.m3u8/')).toBe('media');
  expect(httpTrafficClass('POST', '/api/broadcasts/abc/chunks?unused=1')).toBe('upload');
  expect(httpTrafficClass('GET', '/api/broadcasts/abc')).toBe('control');
  expect(httpTrafficClass('GET', '/api/rooms/slug/broadcasts')).toBe('control');
  expect(httpTrafficClass('GET', '/api/health/live/')).toBe('exempt');
  expect(httpTrafficClass('OPTIONS', '/api/broadcasts/abc/hls/a.ts')).toBe('exempt');
});
it('keeps host uploads and control requests available after shared-network HLS reads are exhausted', async () => {
  await fixture(
    async (url, activity) => {
      const playlist = '/api/broadcasts/11111111-1111-4111-8111-111111111111/hls/index.m3u8';
      const segments = [
        playlist,
        '/api/broadcasts/11111111-1111-4111-8111-111111111111/hls/segment0.ts',
        '/API/broadcasts/11111111-1111-4111-8111-111111111111/hls/segment1.ts/',
      ];
      const shared = {
        Origin: 'http://allowed.test',
        'X-Forwarded-For': '203.0.113.8',
      };
      for (const path of segments) {
        const response = await fetch(url + path, { headers: shared });
        expect(response.status).toBe(200);
        await response.text();
      }
      const blockedMedia = await fetch(url + playlist, { headers: shared });
      expect(blockedMedia.status).toBe(429);
      expect(blockedMedia.headers.get('retry-after')).toBe('60');
      expect(blockedMedia.headers.get('access-control-allow-origin')).toBe('http://allowed.test');
      expect(await blockedMedia.json()).toMatchObject({ error: 'rate_limited' });
      for (const path of [
        '/api/broadcasts/11111111-1111-4111-8111-111111111111/chunks',
        '/api/broadcasts/11111111-1111-4111-8111-111111111111/chunks?retry=0',
      ]) {
        const response = await fetch(url + path, {
          method: 'POST',
          headers: { ...shared, 'content-type': 'application/octet-stream' },
          body: 'webm',
        });
        expect(response.status).toBe(204);
      }
      const blockedUpload = await fetch(
        url + '/api/broadcasts/11111111-1111-4111-8111-111111111111/chunks',
        {
          method: 'POST',
          headers: { ...shared, 'content-type': 'application/octet-stream' },
          body: 'webm',
        },
      );
      expect(blockedUpload.status).toBe(429);
      expect(blockedUpload.headers.get('retry-after')).toBe('60');
      expect(await blockedUpload.json()).toMatchObject({ error: 'rate_limited' });
      for (let index = 0; index < 2; index++) {
        const response = await fetch(url + '/api/rooms/example', { headers: shared });
        expect(response.status).toBe(200);
        await response.text();
      }
      const blockedControl = await fetch(url + '/api/rooms/example', { headers: shared });
      expect(blockedControl.status).toBe(429);
      expect(blockedControl.headers.get('retry-after')).toBe('60');
      await blockedControl.text();
      expect((await fetch(url + '/api/health')).status).toBe(200);
      const otherNetwork = await fetch(url + playlist, {
        headers: { ...shared, 'X-Forwarded-For': '203.0.113.9' },
      });
      expect(otherNetwork.status).toBe(200);
      await otherNetwork.text();
      expect(activity.media()).toBe(4);
      expect(activity.uploads()).toBe(2);
      expect(activity.guest()).toBe(0);
    },
    {
      HTTP_RATE_LIMIT: '2',
      HLS_RATE_LIMIT: '3',
      UPLOAD_NETWORK_RATE_LIMIT: '2',
      TRUSTED_PROXIES: '127.0.0.1',
    },
  );
});
it('rejects an abusive chunk before the raw parser once the network allowance is spent', async () => {
  await fixture(
    async (url, activity) => {
      const path = '/api/broadcasts/11111111-1111-4111-8111-111111111111/chunks';
      const oversize = await fetch(url + path, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: Buffer.alloc(2_000_001),
      });
      expect(oversize.status).toBe(413);
      await oversize.arrayBuffer();
      const accepted = await fetch(url + path, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: Buffer.from('webm'),
      });
      expect(accepted.status).toBe(204);
      const blocked = await fetch(url + path, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: Buffer.alloc(2_000_001),
      });
      expect(blocked.status).toBe(429);
      expect(blocked.headers.get('retry-after')).toBe('60');
      expect(await blocked.json()).toMatchObject({ error: 'rate_limited' });
      expect(activity.uploads()).toBe(1);
      const control = await fetch(url + '/api/rooms/example');
      expect(control.status).toBe(200);
      await control.text();
    },
    { UPLOAD_NETWORK_RATE_LIMIT: '2', HTTP_RATE_LIMIT: '10' },
  );
});
