import { expect, it } from 'vitest';
import { SerializedOperations } from './serialized-operations';
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
