import express, { type ErrorRequestHandler } from 'express';
import { createServer } from 'node:http';
import { expect, it } from 'vitest';
import { broadcastChunkParser } from './chunk-parser';

it('admits the exact raw chunk limit and refuses oversize without raising the JSON limit', async () => {
  const app = express();
  let writes = 0;
  app.use('/api/broadcasts/:id/chunks', broadcastChunkParser);
  app.use(express.json({ limit: 1024 }));
  app.post('/api/broadcasts/:id/chunks', (request, response) => {
    expect(Buffer.isBuffer(request.body)).toBe(true);
    expect(request.body.length).toBe(2_000_000);
    writes++;
    response.sendStatus(204);
  });
  app.post('/ordinary', (_request, response) => {
    writes++;
    response.sendStatus(204);
  });
  const errors: ErrorRequestHandler = (error: { status?: number }, _request, response, next) => {
    if (response.headersSent) {
      next(error);
      return;
    }
    response.sendStatus(error.status ?? 500);
  };
  app.use(errors);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No HTTP port');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const post = (body: Buffer<ArrayBuffer>) =>
      fetch(`${base}/api/broadcasts/id/chunks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body,
      });
    expect((await post(Buffer.alloc(2_000_000))).status).toBe(204);
    expect((await post(Buffer.alloc(2_000_001))).status).toBe(413);
    expect(
      (
        await fetch(`${base}/ordinary`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: 'x'.repeat(1024) }),
        })
      ).status,
    ).toBe(413);
    expect(writes).toBe(1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
