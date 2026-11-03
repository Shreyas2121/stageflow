import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { GuestSessionResponse } from '@stageflow/shared';
import {
  GuestEntryCancelled,
  ReplayGuestEntry,
  replayPathFor,
  replayReturnPath,
} from './guest-entry';
import { usableSession } from './session-store';

const id = '550e8400-e29b-41d4-a716-446655440000';
const path = `/replay/${id}`;
const now = 1_700_000_000_000;

function token(exp: number): string {
  return `header.${btoa(JSON.stringify({ exp }))}.signature`;
}

const fresh: GuestSessionResponse = {
  userId: id,
  displayName: 'Ada',
  token: token(Math.floor(now / 1000) + 60),
};
const expired: GuestSessionResponse = {
  ...fresh,
  token: token(Math.floor(now / 1000) - 5),
};

function entryFor(
  createGuest: (displayName: string, signal: AbortSignal) => Promise<GuestSessionResponse>,
) {
  const setSession = vi.fn();
  const entry = new ReplayGuestEntry({ createGuest, setSession, now: () => now });
  return { entry, setSession };
}

describe('replay return paths', () => {
  it('keeps only the exact replay path', () => {
    expect(replayReturnPath(path)).toBe(path);
    expect(replayPathFor(id)).toBe(path);
    const upper = id.toUpperCase();
    expect(replayReturnPath(`/replay/${upper}`)).toBe(`/replay/${upper}`);
  });

  it.each([
    `https://evil.example/replay/${id}`,
    `//evil.example/replay/${id}`,
    '/\\evil.example',
    '\\\\evil.example',
    `https://replay.invalid/replay/${id}`,
    ` /replay/${id}`,
    `/replay/${id} `,
    `/replay/${id}\n`,
    `replay/${id}`,
    `/replay/${id}?next=https://evil.example`,
    `/replay/${id}#hash`,
    `/replay/${id}/extra`,
    `/replay/${id}/`,
    `/replay/${id}%2f%2fevil.example`,
    '/Replay/' + id,
    '/replay/not-a-uuid',
    'javascript:alert(1)',
    '/foo',
    '',
  ])('refuses %s', (value) => {
    expect(replayReturnPath(value)).toBeNull();
  });

  it('refuses an id that is not the whole path', () => {
    expect(replayPathFor('not-a-uuid')).toBeNull();
    expect(replayPathFor(`${id}/extra`)).toBeNull();
    expect(replayPathFor(`${id}?next=https://evil.example`)).toBeNull();
    expect(replayPathFor(`\\evil.example`)).toBeNull();
  });
});

describe('ReplayGuestEntry', () => {
  it('creates a guest and returns to the same replay without another request', async () => {
    const createGuest = vi.fn(() => Promise.resolve(fresh));
    const { entry, setSession } = entryFor(createGuest);
    await expect(entry.submit('  Ada  ', path)).resolves.toBe(path);
    expect(createGuest).toHaveBeenCalledExactlyOnceWith('Ada', expect.any(AbortSignal));
    expect(setSession).toHaveBeenCalledExactlyOnceWith(fresh);
    const source = readFileSync(new URL('./guest-entry.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/createRoom|getRoom|features\/rooms/);
    const page = readFileSync(new URL('../../pages/ReplayPage.tsx', import.meta.url), 'utf8');
    expect(page).toContain('useReplayGuestEntry');
    expect(page).toContain('replayPathFor');
    expect(page).not.toContain('Enter a name on the home page');
  });

  it('does not store an expired guest', async () => {
    const createGuest = vi.fn(() => Promise.resolve(expired));
    const { entry, setSession } = entryFor(createGuest);
    expect(usableSession(expired, now)).toBeNull();
    expect(usableSession(fresh, now)).toEqual(fresh);
    expect(usableSession({ ...fresh, token: 'opaque-token' }, now)?.token).toBe('opaque-token');
    await expect(entry.submit('Ada', path)).rejects.toThrow(
      'That guest session expired. Enter your name again.',
    );
    expect(setSession).not.toHaveBeenCalled();
  });

  it('does not start a guest for an invalid name or an external return', async () => {
    let signal: AbortSignal | undefined;
    let resolveGuest: (session: GuestSessionResponse) => void = () => undefined;
    const createGuest = vi.fn(
      (_displayName: string, next: AbortSignal) =>
        new Promise<GuestSessionResponse>((resolve) => {
          signal = next;
          resolveGuest = resolve;
        }),
    );
    const { entry, setSession } = entryFor(createGuest);
    const pending = entry.submit('Ada', path);
    await expect(entry.submit('Ada', 'https://evil.example/phish')).rejects.toThrow(
      'That replay link is not valid.',
    );
    await expect(entry.submit('   ', path)).rejects.toThrow(
      'Enter a display name from 1 to 40 characters.',
    );
    expect(signal?.aborted).toBe(false);
    expect(createGuest).toHaveBeenCalledOnce();
    resolveGuest(fresh);
    await expect(pending).resolves.toBe(path);
    expect(setSession).toHaveBeenCalledOnce();
  });

  it('drops a cancelled guest and ignores a late response', async () => {
    let resolveGuest: (session: GuestSessionResponse) => void = () => undefined;
    const createGuest = vi.fn(
      (_displayName: string, signal: AbortSignal) =>
        new Promise<GuestSessionResponse>((resolve, reject) => {
          resolveGuest = resolve;
          signal.addEventListener('abort', () => reject(signal.reason));
        }),
    );
    const { entry, setSession } = entryFor(createGuest);
    const pending = entry.submit('Ada', path);
    const rejection = expect(pending).rejects.toBeInstanceOf(GuestEntryCancelled);
    entry.cancel();
    await rejection;
    resolveGuest(fresh);
    expect(setSession).not.toHaveBeenCalled();
  });

  it('keeps only the latest guest when a new name replaces an in-flight request', async () => {
    const signals: AbortSignal[] = [];
    const resolvers: Array<(session: GuestSessionResponse) => void> = [];
    const createGuest = vi.fn(
      (_displayName: string, signal: AbortSignal) =>
        new Promise<GuestSessionResponse>((resolve) => {
          signals.push(signal);
          resolvers.push(resolve);
        }),
    );
    const { entry, setSession } = entryFor(createGuest);
    const first = entry.submit('Ada', path);
    const second = entry.submit('Grace', path);
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
    const firstDone = expect(first).rejects.toBeInstanceOf(GuestEntryCancelled);
    const secondDone = expect(second).resolves.toBe(path);
    const replacement = { ...fresh, displayName: 'Grace' };
    resolvers[0]?.(fresh);
    resolvers[1]?.(replacement);
    await firstDone;
    await secondDone;
    expect(createGuest).toHaveBeenNthCalledWith(2, 'Grace', signals[1]);
    expect(setSession).toHaveBeenCalledExactlyOnceWith(replacement);
  });
});
