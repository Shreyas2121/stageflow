import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { expect, it, vi } from 'vitest';
import { RedisGoogleState } from './google-state';
it('uses isolated short-lived Google keys and atomic single-use reads, then quits Redis', async () => {
  const redis = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: 0 });
  const namespace = 'sf:itest:google:' + randomUUID();
  const store = new RedisGoogleState(redis, namespace);
  const stateKey = namespace + ':google:state:state';
  const ticketKey = namespace + ':google:ticket:ticket';
  const state = {
    kind: 'sign-in' as const,
    verifier: 'private-verifier',
    browserHash: 'browser-hash',
  };
  try {
    await store.putState('state', state);
    expect(await redis.ttl(stateKey)).toBeGreaterThan(295);
    expect(await redis.ttl(stateKey)).toBeLessThanOrEqual(300);
    const states = await Promise.all([store.takeState('state'), store.takeState('state')]);
    expect(states.filter(Boolean)).toEqual([state]);
    await store.putState('state', {
      kind: 'link',
      userId: randomUUID(),
      verifier: 'private-verifier',
      browserHash: 'browser-hash',
      tokenHash: 'token-hash',
    });
    await redis.expire(stateKey, 0);
    expect(await store.takeState('state')).toBeNull();
    const session = { code: 'provider-code', state };
    await store.putTicket('ticket', session);
    expect(await redis.ttl(ticketKey)).toBeGreaterThan(55);
    expect(await redis.ttl(ticketKey)).toBeLessThanOrEqual(60);
    const tickets = await Promise.all([store.takeTicket('ticket'), store.takeTicket('ticket')]);
    expect(tickets.filter(Boolean)).toEqual([session]);
    await store.putTicket('ticket', session);
    await redis.expire(ticketKey, 0);
    expect(await store.takeTicket('ticket')).toBeNull();
  } finally {
    await redis.del(stateKey, ticketKey);
    await store.onModuleDestroy();
  }
  await vi.waitFor(() => expect(redis.status).toBe('end'));
});
