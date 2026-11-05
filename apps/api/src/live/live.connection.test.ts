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
  owner: string | null = null;
  async set(_key: string, token: string): Promise<'OK' | null> {
    if (this.owner) return null;
    this.owner = token;
    return 'OK';
  }
  async eval(_script: string, _count: number, _key: string, token: string): Promise<number> {
    if (this.owner !== token) return 0;
    this.owner = null;
    return 1;
  }
  pages: [string, string[]][] = [['0', []]];
  hashes: Record<string, Record<string, string>> = {};
  async hgetall(key: string): Promise<Record<string, string>> {
    this.calls.push(`hgetall:${key}`);
    return this.hashes[key] ?? {};
  }
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
  vi.restoreAllMocks();
});

it('finds a suspended membership across scan pages without deleting any keys', async () => {
  const redis = new FakeRedis();
  redis.pages = [
    ['12', ['preview:room:one:participants']],
    ['0', ['preview:room:two:participants']],
  ];
  redis.hashes = {
    'preview:room:one:participants': { one: JSON.stringify({ userId: 'other-user' }) },
    'preview:room:two:participants': {
      one: JSON.stringify({ userId: 'target-user', suspended: true }),
    },
  };
  expect(await new LiveConnection(redis, 'preview').hasUserMembership('target-user')).toBe(true);
  expect(redis.patterns).toEqual(['preview:room:*:participants', 'preview:room:*:participants']);
  expect(redis.deleted).toEqual([]);
});

it('finishes an empty scan and ignores other users and JSON values without a user id', async () => {
  const redis = new FakeRedis();
  const connection = new LiveConnection(redis, 'preview');
  expect(await connection.hasUserMembership('target-user')).toBe(false);
  redis.pages = [
    ['12', []],
    ['0', ['preview:room:one:participants']],
  ];
  redis.hashes = {
    'preview:room:one:participants': {
      one: JSON.stringify({ userId: 'other-user' }),
      two: 'null',
      three: '{}',
    },
  };
  expect(await connection.hasUserMembership('target-user')).toBe(false);
  expect(redis.deleted).toEqual([]);
});

it.each(['scan', 'hgetall'] as const)('propagates a Redis %s failure', async (command) => {
  const redis = new FakeRedis();
  redis.pages = [['0', ['preview:room:one:participants']]];
  vi.spyOn(redis, command).mockRejectedValue(new Error('Redis unavailable'));
  await expect(
    new LiveConnection(redis, 'preview').hasUserMembership('target-user'),
  ).rejects.toThrow('Redis unavailable');
  expect(redis.deleted).toEqual([]);
});

it('fails closed for malformed participant JSON', async () => {
  const redis = new FakeRedis();
  redis.pages = [['0', ['preview:room:one:participants']]];
  redis.hashes = { 'preview:room:one:participants': { broken: '{invalid' } };
  await expect(
    new LiveConnection(redis, 'preview').hasUserMembership('target-user'),
  ).rejects.toThrow();
});

it.each(['repeated cursor', 'page limit', 'deadline'])(
  'bounds an unfinished membership scan at its %s',
  async (reason) => {
    const redis = new FakeRedis();
    const scan = vi
      .spyOn(redis, 'scan')
      .mockImplementation(async (cursor) => [
        reason === 'repeated cursor' ? '12' : String(Number(cursor) + 1),
        [],
      ]);
    if (reason === 'deadline') {
      vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValue(3000);
    }
    await expect(
      new LiveConnection(redis, 'preview').hasUserMembership('target-user'),
    ).rejects.toThrow('Live membership scan did not finish.');
    expect(scan.mock.calls.length).toBe(
      reason === 'repeated cursor' ? 2 : reason === 'page limit' ? 1000 : 0,
    );
  },
);

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
      'Live startup failed; the API will not listen.',
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

it('refuses a second owner before any presence reset and preserves the guard on abrupt close', async () => {
  const redis = new FakeRedis();
  redis.owner = 'existing-owner';
  const failInFlight = vi.fn(async () => {});
  const connection = new LiveConnection(redis, 'preview', failInFlight);
  await expect(connection.open()).rejects.toThrow('already has an API owner');
  expect(redis.patterns).toEqual([]);
  expect(redis.owner).toBe('existing-owner');
  expect(failInFlight).not.toHaveBeenCalled();
});

it('waits for broadcast failure before clearing presence or becoming ready', async () => {
  const redis = new FakeRedis();
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const failInFlight = vi.fn(() => gate);
  const connection = new LiveConnection(redis, 'preview', failInFlight);
  const opening = connection.open();
  await vi.waitFor(() => expect(failInFlight).toHaveBeenCalledOnce());
  expect(redis.owner).not.toBeNull();
  expect(redis.patterns).toEqual([]);
  expect(connection.isReady()).toBe(false);
  finish();
  await opening;
  expect(redis.patterns).toEqual(['preview:room:*']);
  expect(connection.isReady()).toBe(true);
});

it('does not clear presence or become ready if broadcast restart cleanup fails', async () => {
  const redis = new FakeRedis();
  const connection = new LiveConnection(redis, 'preview', async () => {
    throw new Error('database unavailable');
  });
  await expect(connection.open()).rejects.toThrow('database unavailable');
  expect(connection.isReady()).toBe(false);
  expect(redis.patterns).toEqual([]);
  expect(redis.deleted).toEqual([]);
  expect(redis.owner).not.toBeNull();
  expect(redis.status).toBe('end');
});
it('releases only its own guard after graceful shutdown, without treating shutdown as loss', async () => {
  const redis = new FakeRedis();
  const connection = new LiveConnection(redis);
  await connection.open();
  connection.onModuleDestroy();
  expect(connection.isReady()).toBe(false);
  expect(redis.owner).not.toBeNull();
  await connection.onApplicationShutdown();
  expect(redis.owner).toBeNull();
  expect(redis.status).toBe('end');
});
it('does not delete a replacement guard during graceful shutdown', async () => {
  const redis = new FakeRedis();
  const connection = new LiveConnection(redis);
  await connection.open();
  redis.owner = 'replacement';
  await connection.onApplicationShutdown();
  expect(redis.owner).toBe('replacement');
});
