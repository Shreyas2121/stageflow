import { afterEach, expect, it, vi } from 'vitest';
import { SocketAuthorization } from './socket-authorization';
import type { SessionsService } from '../sessions/sessions.service';
import type { User } from '../users/user.entity';

afterEach(() => vi.useRealTimers());

it('expires idle connections at the server deadline and refuses subsequent commands', () => {
  vi.useFakeTimers();
  const disconnect = vi.fn();
  const lease = new SocketAuthorization(
    {} as SessionsService,
    'token',
    {} as User,
    Date.now() + 1000,
    disconnect,
  );
  expect(lease.valid()).toBe(true);
  vi.advanceTimersByTime(1000);
  expect(disconnect).toHaveBeenCalledOnce();
  expect(lease.valid()).toBe(false);
});

it('coalesces freshness checks for ICE bursts and cannot resurrect an invalidated lease', async () => {
  vi.useFakeTimers();
  const user = { id: 'user', sessionVersion: 0, isGuest: false } as User;
  let resolve!: (user: User) => void;
  const verifyToken = vi.fn(
    () =>
      new Promise<User>((done) => {
        resolve = done;
      }),
  );
  const disconnect = vi.fn();
  const lease = new SocketAuthorization(
    { verifyToken } as unknown as SessionsService,
    'token',
    user,
    Date.now() + 60000,
    disconnect,
  );
  for (let i = 0; i < 100; i++) expect(lease.valid()).toBe(true);
  expect(verifyToken).not.toHaveBeenCalled();
  vi.advanceTimersByTime(5000);
  const checks = Array.from({ length: 100 }, () => lease.valid());
  expect(verifyToken).toHaveBeenCalledOnce();
  lease.revoke();
  resolve(user);
  expect(await Promise.all(checks)).toEqual(Array(100).fill(false));
  expect(disconnect).toHaveBeenCalledOnce();
});

it('fails closed when revalidation fails or the account version changes', async () => {
  vi.useFakeTimers();
  for (const verifyToken of [
    vi.fn(async () => {
      throw new Error('offline');
    }),
    vi.fn(async () => ({ id: 'user', sessionVersion: 1, isGuest: false })),
  ]) {
    const disconnect = vi.fn();
    const lease = new SocketAuthorization(
      { verifyToken } as unknown as SessionsService,
      'token',
      { id: 'user', sessionVersion: 0, isGuest: false } as User,
      Date.now() + 60000,
      disconnect,
    );
    vi.advanceTimersByTime(5000);
    expect(await lease.valid()).toBe(false);
    expect(disconnect).toHaveBeenCalledOnce();
  }
});
