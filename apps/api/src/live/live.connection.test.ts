import { afterEach, expect, it, vi } from 'vitest';
import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { bindLiveResetExit, LiveConnection, type LiveRedisClient } from './live.connection';
import { LiveReadinessController } from './live.readiness.controller';

class FakeRedis implements LiveRedisClient {
  status = 'wait';
  readonly calls: string[] = [];
  readonly patterns: string[] = [];
  readonly deleted: string[][] = [];
  failConnect = false;
  failPing = false;
  pages: [string, string[]][] = [['0', []]];
  private readonly listeners = new Map<string, ((error?: Error) => void)[]>();

  async connect(): Promise<void> {
    this.calls.push('connect');
    if (this.failConnect) throw new Error('connect failed');
    this.status = 'ready';
  }

  async ping(): Promise<string> {
    this.calls.push('ping');
    if (this.failPing) throw new Error('ping failed');
    return 'PONG';
  }

  async scan(
    cursor: string,
    match: 'MATCH',
    pattern: string,
    count: 'COUNT',
    countValue: number,
  ): Promise<[string, string[]]> {
    this.calls.push(`scan:${cursor}:${match}:${pattern}:${count}:${countValue}`);
    this.patterns.push(pattern);
    return this.pages.shift() ?? ['0', []];
  }

  async del(...keys: string[]): Promise<number> {
    this.deleted.push(keys);
    return keys.length;
  }

  disconnect(): void {
    this.calls.push('disconnect');
    this.status = 'end';
  }

  on(event: 'error' | 'close' | 'end', listener: (error?: Error) => void): void {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
  }

  emit(event: 'error' | 'close' | 'end', error?: Error): void {
    for (const listener of this.listeners.get(event) ?? []) listener(error);
  }
}

function silence() {
  return vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
}

afterEach(() => {
  vi.useRealTimers();
});

it('clears only sf:room keys on startup and reports live readiness', async () => {
  const redis = new FakeRedis();
  redis.pages = [
    ['10', ['sf:room:one:rev', 'sf:room:one:participants']],
    ['0', ['sf:room:two:stage']],
  ];
  const connection = new LiveConnection(redis, 'sf');
  const readiness = new LiveReadinessController(connection);
  expect(() => readiness.get()).toThrow(ServiceUnavailableException);
  await connection.open();
  expect(readiness.get()).toEqual({ ok: true });
  expect(redis.patterns).toEqual(['sf:room:*', 'sf:room:*']);
  expect(redis.deleted).toEqual([
    ['sf:room:one:rev', 'sf:room:one:participants'],
    ['sf:room:two:stage'],
  ]);
  expect(redis.calls.some((call) => call.startsWith('scan:'))).toBe(true);
  expect(redis.calls).not.toContain('quit');
});

it('stays unready and does not reset sessions when startup cannot reach Redis', async () => {
  const logger = silence();
  try {
    const redis = new FakeRedis();
    redis.failPing = true;
    const connection = new LiveConnection(redis);
    const reset = vi.fn();
    connection.whenLost(reset);
    await expect(connection.open()).rejects.toThrow(
      'Redis startup failed; the API will not listen.',
    );
    expect(connection.isReady()).toBe(false);
    expect(redis.calls).toContain('disconnect');
    expect(reset).not.toHaveBeenCalled();
    redis.emit('close');
    expect(reset).not.toHaveBeenCalled();
  } finally {
    logger.mockRestore();
  }
});

it('resets once when the connection closes and ignores a later command error', async () => {
  const logger = silence();
  try {
    const redis = new FakeRedis();
    const connection = new LiveConnection(redis);
    const readiness = new LiveReadinessController(connection);
    const reset = vi.fn();
    await connection.open();
    connection.whenLost(reset);
    redis.emit('error', new Error('command failed'));
    expect(connection.isReady()).toBe(true);
    expect(reset).not.toHaveBeenCalled();
    redis.status = 'end';
    redis.emit('close');
    redis.emit('end');
    expect(connection.isReady()).toBe(false);
    expect(reset).toHaveBeenCalledTimes(1);
    expect(() => readiness.get()).toThrow(ServiceUnavailableException);
    try {
      readiness.get();
    } catch (error) {
      expect((error as ServiceUnavailableException).getResponse()).toEqual({ ok: false });
    }
    const late = vi.fn();
    connection.whenLost(late);
    expect(late).toHaveBeenCalledTimes(1);
    expect(logger).toHaveBeenCalledWith(
      expect.stringContaining('Redis lost; resetting live sessions without resume'),
    );
  } finally {
    logger.mockRestore();
  }
});

it('does not treat process shutdown as Redis loss', async () => {
  const redis = new FakeRedis();
  const connection = new LiveConnection(redis);
  const reset = vi.fn();
  await connection.open();
  connection.whenLost(reset);
  connection.close();
  connection.close();
  redis.emit('end');
  expect(reset).not.toHaveBeenCalled();
  expect(connection.isReady()).toBe(false);
  expect(redis.calls.filter((call) => call === 'disconnect')).toHaveLength(1);
});

it('schedules one bounded process exit after Redis loss', async () => {
  const logger = silence();
  try {
    const redis = new FakeRedis();
    const connection = new LiveConnection(redis);
    const exit = vi.fn();
    await connection.open();
    bindLiveResetExit(connection, exit, 1000);
    vi.useFakeTimers();
    redis.emit('close');
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(999);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(exit).toHaveBeenCalledTimes(1);
  } finally {
    logger.mockRestore();
  }
});
