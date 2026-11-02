import { expect, it } from 'vitest';
import { SerializedOperations, WorkCapacityError } from './serialized-operations';
it('serializes one key while unrelated keys progress', async () => {
  const queue = new SerializedOperations();
  const events: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = queue.run('room:a', async () => {
    events.push('first');
    await gate;
    events.push('done');
  });
  const second = queue.run('room:a', async () => {
    events.push('second');
  });
  await queue.run('room:b', async () => {
    events.push('other');
  });
  expect(events).toEqual(['first', 'other']);
  release();
  await Promise.all([first, second]);
  expect(events).toEqual(['first', 'other', 'done', 'second']);
});
it('recovers after rejected work and supports subsequent operations', async () => {
  const queue = new SerializedOperations();
  await expect(
    queue.run('socket:a', async () => {
      throw new Error('failed');
    }),
  ).rejects.toThrow('failed');
  expect(await queue.run('socket:a', async () => 42)).toBe(42);
  await Promise.resolve();
  expect(await queue.run('socket:a', async () => 'fresh')).toBe('fresh');
});

it('rejects excess work before executing it and gives cleanup the next queue slot', async () => {
  const queue = new SerializedOperations({ maxPending: 2, maxPerKey: 2, cleanupReserve: 1 });
  const events: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const active = queue.run('room:a', async () => {
    events.push('active');
    await gate;
  });
  const waiting = queue.run('room:a', async () => {
    events.push('normal');
  });
  await expect(
    queue.run('room:a', async () => {
      events.push('overflow');
    }),
  ).rejects.toBeInstanceOf(WorkCapacityError);
  await expect(
    queue.run('room:b', async () => {
      events.push('global-overflow');
    }),
  ).rejects.toBeInstanceOf(WorkCapacityError);
  const cleanup = queue.run(
    'room:a',
    async () => {
      events.push('cleanup');
    },
    true,
  );
  await expect(queue.run('room:b', async () => undefined, true)).rejects.toBeInstanceOf(
    WorkCapacityError,
  );
  release();
  await Promise.all([active, waiting, cleanup]);
  expect(events).toEqual(['active', 'cleanup', 'normal']);
  expect(await queue.run('room:a', async () => 'reused')).toBe('reused');
});
it('reserves room capacity separately from socket capacity for nested cleanup', async () => {
  const queue = new SerializedOperations({ maxPending: 1, maxPerKey: 1, cleanupReserve: 1 });
  expect(
    await queue.run('socket:host', () => queue.run('room:a', async () => 'left', true), true),
  ).toBe('left');
  expect(await queue.run('socket:host', async () => 'fresh')).toBe('fresh');
  expect(await queue.run('socket:host', async () => 'fresh-again')).toBe('fresh-again');
});
it('waits for active and queued work before the shutdown hook can release ownership', async () => {
  const queue = new SerializedOperations();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const work = queue.run('socket:a', () => queue.run('room:a', () => gate));
  let drained = false;
  const shutdown = queue.onModuleDestroy().then(() => {
    drained = true;
  });
  await Promise.resolve();
  expect(drained).toBe(false);
  release();
  await Promise.all([work, shutdown]);
  expect(drained).toBe(true);
});
