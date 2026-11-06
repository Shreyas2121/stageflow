import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { availableParallelism, tmpdir } from 'node:os';
import { join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Server } from 'socket.io';
import { afterAll, expect, it } from 'vitest';
import { env } from '../config/env';
import { LiveConnection } from '../live/live.connection';
import { LiveReadinessController } from '../live/live.readiness.controller';
import {
  PasswordBusyError,
  PasswordPool,
  closePasswordWorkers,
  hashPassword,
  passwordAdmissionLimit,
  passwordWorkerCount,
  passwordWorkerFile,
} from './password';

afterAll(() => closePasswordWorkers());

async function delayDuring(work: Promise<unknown>): Promise<number> {
  const histogram = monitorEventLoopDelay({ resolution: 10 });
  histogram.enable();
  histogram.reset();
  let maxTimer = 0;
  let previous = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    maxTimer = Math.max(maxTimer, now - previous - 10);
    previous = now;
  }, 10);
  try {
    await work;
  } finally {
    clearInterval(timer);
    histogram.disable();
  }
  return Math.max(maxTimer, histogram.max / 1e6);
}

it('clamps the worker count to the machine and keeps bcrypt cost 12 in the worker', () => {
  const source = readFileSync(passwordWorkerFile(), 'utf8');
  expect(passwordWorkerCount(1)).toBe(1);
  expect(passwordWorkerCount()).toBeGreaterThanOrEqual(1);
  expect(passwordWorkerCount()).toBeLessThanOrEqual(availableParallelism());
  expect(passwordWorkerCount(100)).toBe(availableParallelism());
  expect(passwordAdmissionLimit()).toBe(passwordWorkerCount() + env.PASSWORD_QUEUE_LIMIT);
  expect(source).toContain('const COST = 12');
  expect(source).toContain('hash(password, COST)');
});

it('rejects overflow without retaining the rejected password and drops the queue on close', async () => {
  const pool = new PasswordPool({ workers: 1, queueLimit: 1 });
  const first = pool.hash('one-password');
  const second = pool.hash('two-password');
  const overflow = pool.hash('three-password');
  const settled = Promise.allSettled([first, second, overflow]);
  expect(pool.retainedPasswordCount()).toBe(1);
  await pool.close();
  const results = await settled;
  expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected', 'rejected']);
  for (const result of results) {
    expect(result.status === 'rejected' && String(result.reason)).not.toContain('password');
    expect(result.status === 'rejected' && result.reason).toBeInstanceOf(PasswordBusyError);
  }
  expect(pool.retainedPasswordCount()).toBe(0);
  await expect(pool.hash('later-password')).rejects.toMatchObject({ reason: 'closed' });
});

it('exits after the last password job when nothing else is running', async () => {
  const child = spawn(
    process.execPath,
    [
      '-r',
      'ts-node/register/transpile-only',
      '-e',
      "const { hashPassword } = require('./src/sessions/password.ts'); hashPassword('exit-check-password').then((value) => { if (!String(value).includes('$12$')) process.exit(2); }).catch(() => process.exit(1));",
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, NODE_OPTIONS: '' },
      windowsHide: true,
    },
  );
  let output = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    output += chunk;
  });
  child.stderr?.on('data', (chunk: string) => {
    output += chunk;
  });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`password process stayed alive\n${output}`));
    }, 15_000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  expect(exitCode, output).toBe(0);
}, 20_000);

it('stops a stuck worker and does not keep its password', async () => {
  const pool = new PasswordPool({ workers: 1, queueLimit: 0, jobTimeoutMs: 20 });
  const started = performance.now();
  await expect(pool.hash('stuck-password')).rejects.toMatchObject({ reason: 'failed' });
  expect(performance.now() - started).toBeLessThan(5_000);
  expect(pool.retainedPasswordCount()).toBe(0);
  await pool.close();
});

it('replaces a crashed worker and still verifies a later hash', async () => {
  const pool = new PasswordPool({ workers: 1, queueLimit: 0 });
  const pending = pool.hash('crash-password');
  await pool.discardRunningWorker();
  await expect(pending).rejects.toBeInstanceOf(PasswordBusyError);
  const passwordHash = await pool.hash('recovered-password');
  expect(passwordHash).toContain('$12$');
  expect(passwordHash).not.toContain('recovered-password');
  expect(await pool.compare('recovered-password', passwordHash)).toBe(true);
  expect(pool.workersStarted()).toBe(2);
  expect(pool.retainedPasswordCount()).toBe(0);
  await pool.close();
}, 15_000);

it('stops spawning after repeated worker boot failures', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'stageflow-password-'));
  try {
    const workerFile = join(directory, 'exit-worker.cjs');
    await writeFile(workerFile, "'use strict';\nprocess.exit(1);\n");
    const pool = new PasswordPool({ workers: 1, queueLimit: 2, workerFile });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(pool.hash('boot-password')).rejects.toBeInstanceOf(PasswordBusyError);
    }
    expect(pool.workersStarted()).toBeLessThanOrEqual(3);
    expect(pool.retainedPasswordCount()).toBe(0);
    await pool.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('keeps readiness and socket latency low while the password budget is saturated', async () => {
  class ProbeModule {}
  Module({
    controllers: [LiveReadinessController],
    providers: [{ provide: LiveConnection, useValue: { isReady: () => true } }],
  })(ProbeModule);

  const app = await NestFactory.create<NestExpressApplication>(ProbeModule, {
    logger: false,
    abortOnError: false,
  });
  const io = new Server(app.getHttpServer(), { cors: { origin: true } });
  let url = '';
  try {
    app.setGlobalPrefix('api');
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
    const idleDelay = await delayDuring(new Promise((resolve) => setTimeout(resolve, 150)));
    const parallel = Math.min(4, Math.max(1, availableParallelism()));
    const pool = new PasswordPool({ workers: parallel, queueLimit: 0 });
    const started = performance.now();
    const readiness: number[] = [];
    const sockets: number[] = [];
    let stop = false;
    const probing = (async () => {
      while (!stop) {
        const readyStarted = performance.now();
        const ready = await fetch(`${url}/api/health/live`);
        if (!ready.ok) throw new Error(`readiness ${ready.status}`);
        await ready.arrayBuffer();
        readiness.push(performance.now() - readyStarted);
        const socketStarted = performance.now();
        const handshake = await fetch(`${url}/socket.io/?EIO=4&transport=polling`);
        if (!handshake.ok) throw new Error(`socket ${handshake.status}`);
        const body = await handshake.text();
        if (!body.startsWith('0')) throw new Error('socket handshake was not an open packet');
        sockets.push(performance.now() - socketStarted);
      }
    })();
    const work = Promise.all(
      Array.from({ length: parallel }, () => pool.hash('saturation-password')),
    );
    const loadedDelay = await delayDuring(work);
    stop = true;
    await probing;
    const hashes = await work;
    const slowestHashMs = performance.now() - started;
    expect(hashes.every((value) => value.includes('$12$') && !value.includes('saturation'))).toBe(
      true,
    );
    await pool.close();

    const limit = passwordAdmissionLimit();
    const admitted = Array.from({ length: limit }, () => hashPassword('budget-password'));
    const overflow = hashPassword('budget-overflow').then(
      () => 'fulfilled' as const,
      () => 'rejected' as const,
    );
    const budgetDelay = await delayDuring(Promise.all(admitted));
    expect(await overflow).toBe('rejected');
    const budgetHashes = await Promise.all(admitted);
    expect(budgetHashes).toHaveLength(limit);
    expect(readiness.length).toBeGreaterThan(0);
    expect(sockets.length).toBeGreaterThan(0);
    const readinessMax = Math.max(...readiness);
    const socketMax = Math.max(...sockets);
    console.log(
      JSON.stringify({
        idleDelayMs: Number(idleDelay.toFixed(1)),
        loadedDelayMs: Number(loadedDelay.toFixed(1)),
        budgetDelayMs: Number(budgetDelay.toFixed(1)),
        slowestParallelHashMs: Number(slowestHashMs.toFixed(1)),
        readinessMaxMs: Number(readinessMax.toFixed(1)),
        socketMaxMs: Number(socketMax.toFixed(1)),
        parallel,
        admission: limit,
        samples: readiness.length,
      }),
    );
    const loopCeiling = Math.max(100, idleDelay * 4);
    // Request wall time includes OS scheduling while workers occupy CPUs.
    const requestCeiling = Math.max(250, idleDelay * 4);
    expect(slowestHashMs).toBeGreaterThan(50);
    expect(loadedDelay).toBeLessThan(slowestHashMs / 2);
    expect(loadedDelay).toBeLessThan(loopCeiling);
    expect(budgetDelay).toBeLessThan(loopCeiling);
    expect(readinessMax).toBeLessThan(Math.min(slowestHashMs / 2, requestCeiling));
    expect(socketMax).toBeLessThan(Math.min(slowestHashMs / 2, Math.max(300, idleDelay * 4)));
  } finally {
    io.disconnectSockets(true);
    await app.close();
    await closePasswordWorkers();
  }
}, 30_000);
