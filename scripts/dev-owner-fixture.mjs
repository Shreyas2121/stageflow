import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { startShutdownServer } from './dev-shutdown.mjs';

const require = createRequire(new URL('../apps/api/package.json', import.meta.url));
const Redis = require('ioredis');

const releaseScript =
  "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0";

function redisUrl() {
  if (process.env.REDIS_URL) return process.env.REDIS_URL;
  const text = readFileSync(fileURLToPath(new URL('../.env', import.meta.url)), 'utf8');
  const line = text.split(/\r?\n/).find((item) => item.startsWith('REDIS_URL='));
  if (!line) throw new Error('REDIS_URL is required for the dev owner fixture.');
  return line.slice('REDIS_URL='.length).trim();
}

function holdChild() {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  process.stdout.write(`child ${child.pid}\n`);
  return child;
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await new Promise((resolve) => child.once('exit', () => resolve()));
}

const namespace = process.argv[2];
const mode = process.argv[3];
if (!/^[A-Za-z0-9_-]{1,64}$/.test(namespace ?? '')) {
  throw new Error('The fixture requires an isolated namespace.');
}
if (!['release', 'ignore', 'yield', 'channel'].includes(mode)) {
  throw new Error('The fixture mode must be release, ignore, yield, or channel.');
}

const channel = process.env.STAGEFLOW_DEV_SHUTDOWN;
const token = process.env.STAGEFLOW_DEV_SHUTDOWN_TOKEN;
const ownerToken = `${process.pid}:${randomUUID()}`;
const key = `${namespace}:owner`;

if (mode === 'channel') {
  let held;
  await startShutdownServer({
    channel,
    token,
    onShutdown: async () => {
      await stopChild(held);
      process.exit(0);
    },
  });
  held = holdChild();
  process.stdout.write('ready\n');
} else {
  const redis = new Redis(redisUrl(), {
    connectTimeout: 2000,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    lazyConnect: true,
  });
  redis.on('error', () => {});
  try {
    await redis.connect();
    if (mode === 'ignore') {
      if ((await redis.set(key, ownerToken, 'NX')) !== 'OK') {
        process.stdout.write('refused\n', () => process.exit(1));
      } else {
        holdChild();
        process.stdout.write(`owner ${ownerToken}\nready\n`);
        setInterval(() => {}, 1000);
      }
    } else {
      let held;
      await startShutdownServer({
        channel,
        token,
        onShutdown: async () => {
          if (mode === 'yield') await redis.set(key, 'foreign-owner');
          await redis.eval(releaseScript, 1, key, ownerToken);
          await stopChild(held);
          redis.disconnect();
          process.exit(0);
        },
      });
      if ((await redis.set(key, ownerToken, 'NX')) !== 'OK') {
        process.stdout.write('refused\n', () => process.exit(1));
      } else {
        held = holdChild();
        process.stdout.write(`owner ${ownerToken}\nready\n`);
      }
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
    redis.disconnect();
    process.exit(1);
  }
}
