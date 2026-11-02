import { randomBytes, randomUUID } from 'node:crypto';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { bindDevShutdown } from './dev-shutdown';

function devShutdownPath(id: string): string {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\stageflow-dev-${id}`
    : join(tmpdir(), `stageflow-dev-${id}.sock`);
}

const previous = {
  channel: process.env.STAGEFLOW_DEV_SHUTDOWN,
  token: process.env.STAGEFLOW_DEV_SHUTDOWN_TOKEN,
  nodeEnv: process.env.NODE_ENV,
};
const servers: { close(): Promise<void> }[] = [];

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(async () => {
  restore('STAGEFLOW_DEV_SHUTDOWN', previous.channel);
  restore('STAGEFLOW_DEV_SHUTDOWN_TOKEN', previous.token);
  restore('NODE_ENV', previous.nodeEnv);
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

function request(channel: string, token: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(channel);
    let buffer = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('timed out'));
    }, 2000);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${token}\n`));
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (!buffer.includes('\n')) return;
      clearTimeout(timer);
      socket.end();
      resolve(buffer.slice(0, buffer.indexOf('\n')));
    });
    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

it('does nothing unless the dev supervisor provides a channel', async () => {
  delete process.env.STAGEFLOW_DEV_SHUTDOWN;
  delete process.env.STAGEFLOW_DEV_SHUTDOWN_TOKEN;
  await expect(bindDevShutdown(async () => {})).resolves.toBeUndefined();
});

it('refuses a production shutdown channel', async () => {
  process.env.NODE_ENV = 'production';
  process.env.STAGEFLOW_DEV_SHUTDOWN = devShutdownPath(randomUUID());
  process.env.STAGEFLOW_DEV_SHUTDOWN_TOKEN = randomBytes(16).toString('hex');
  await expect(bindDevShutdown(async () => {})).rejects.toThrow(/not available in production/);
});

it('closes Nest once for the supervisor token and ignores any other token', async () => {
  const channel = devShutdownPath(randomUUID());
  const token = randomBytes(16).toString('hex');
  process.env.NODE_ENV = 'test';
  process.env.STAGEFLOW_DEV_SHUTDOWN = channel;
  process.env.STAGEFLOW_DEV_SHUTDOWN_TOKEN = token;
  let closed = 0;
  const server = await bindDevShutdown(async () => {
    closed += 1;
  });
  if (!server) throw new Error('Dev shutdown channel did not open.');
  servers.push(server);
  await expect(request(channel, 'wrong-token-value')).resolves.toBe('denied');
  expect(closed).toBe(0);
  await expect(request(channel, token)).resolves.toBe('ok');
  const started = Date.now();
  while (closed !== 1 && Date.now() - started < 1000) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await expect(request(channel, token)).resolves.toBe('busy');
  expect(closed).toBe(1);
});
