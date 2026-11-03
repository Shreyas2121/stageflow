import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';
import { describe, expect, it, vi } from 'vitest';
import { LiveRepository } from './live.repository';
import { liveKeys, parseLiveNamespace, roomPrefix } from './live.keys';

const room = { roomId: 'room', hostId: 'host', mode: 'MEETING', status: 'LIVE' } as const;
const command = { type: 'leave', participantId: 'missing' } as const;
const result = JSON.stringify({ ok: true, revision: 0, changed: false, roomEnded: false });
function fixture() {
  const redis = {
    evalsha: vi.fn().mockResolvedValue(result),
    eval: vi.fn().mockResolvedValue(result),
  };
  return { redis, repository: new LiveRepository(redis as unknown as Redis) };
}

describe('Lua script cache', () => {
  it('uses a SHA with nine actual keys and falls back only on a cache miss', async () => {
    const { redis, repository } = fixture();
    redis.evalsha.mockRejectedValueOnce(new Error('NOSCRIPT No matching script. Please use EVAL.'));
    await repository.apply('test:room:one', room, command);
    const loaded = redis.eval.mock.calls[0] as unknown as [string, number, ...string[]];
    const cached = redis.evalsha.mock.calls[0] as unknown as [string, number, ...string[]];
    expect(cached).toEqual([
      createHash('sha1').update(loaded[0]).digest('hex'),
      9,
      ...liveKeys('test:room:one'),
      JSON.stringify({ ...command, room }),
    ]);
    expect(loaded.slice(1)).toEqual(cached.slice(1));
    await repository.apply('test:room:one', room, command);
    expect(redis.evalsha).toHaveBeenCalledTimes(2);
    expect(redis.eval).toHaveBeenCalledOnce();
  });
  it.each([
    'ERR script failed after a write',
    'READONLY replica',
    'Connection is closed.',
    'NOSCRIPTING is not NOSCRIPT',
  ])('does not replay ambiguous or non-cache errors: %s', async (message) => {
    const { redis, repository } = fixture();
    const failure = new Error(message);
    redis.evalsha.mockRejectedValueOnce(failure);
    await expect(repository.apply('test:room:one', room, command)).rejects.toBe(failure);
    expect(redis.eval).not.toHaveBeenCalled();
  });
  it('does not replay a failed fallback', async () => {
    const { redis, repository } = fixture();
    redis.evalsha.mockRejectedValueOnce(new Error('NOSCRIPT missing'));
    redis.eval.mockRejectedValueOnce(new Error('Connection lost'));
    await expect(repository.apply('test:room:one', room, command)).rejects.toThrow(
      'Connection lost',
    );
    expect(redis.evalsha).toHaveBeenCalledOnce();
    expect(redis.eval).toHaveBeenCalledOnce();
  });
});

it('validates namespaces before they become key prefixes or scan patterns', () => {
  expect(parseLiveNamespace(undefined)).toBe('sf');
  expect(roomPrefix('id', parseLiveNamespace('preview_42-blue'))).toBe('preview_42-blue:room:id');
  for (const value of ['', '*', 'sf:room', 'space here', 'a'.repeat(65)])
    expect(() => parseLiveNamespace(value)).toThrow('LIVE_NAMESPACE');
});
