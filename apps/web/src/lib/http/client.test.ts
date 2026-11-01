import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { request } from './client';
import { serviceUrl } from '../../config/env';
import { parseGuest } from '../../features/session/api';
import { parseRoom } from '../../features/rooms/api';

beforeEach(() => vi.stubEnv('VITE_API_BASE_URL', 'http://localhost:4000/'));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
const identity = (value: unknown) => value;
describe('HTTP boundary', () => {
  it('preserves server status, error code and message', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ error: 'room_not_found', message: 'No room' }, { status: 404 }),
        ),
    );
    await expect(request('/rooms/missing', identity)).rejects.toMatchObject({
      status: 404,
      code: 'room_not_found',
      message: 'No room',
    });
  });
  it('provides a status-preserving fallback for a non-JSON server error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('Bad gateway', { status: 502 })));
    await expect(request('/rooms/x', identity)).rejects.toMatchObject({
      status: 502,
      code: 'http_error',
    });
  });
  it('distinguishes network failures from HTTP failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(request('/rooms/x', identity)).rejects.toMatchObject({
      status: null,
      code: 'network_error',
    });
  });
  it('does not start an already cancelled request', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const controller = new AbortController();
    controller.abort();
    const pending = request('/rooms/x', identity, { signal: controller.signal });
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('passes cancellation to fetch and preserves its reason', async () => {
    let received: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            received = init.signal ?? undefined;
            received?.addEventListener('abort', () => reject(received?.reason), { once: true });
          }),
      ),
    );
    const controller = new AbortController();
    const pending = request('/rooms/x', identity, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toBe(controller.signal.reason);
    expect(received?.aborted).toBe(true);
  });
  it('bounds body consumption too and reports timeout separately', async () => {
    const timeout = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () =>
          new Promise((_resolve, reject) => {
            timeout.signal.addEventListener('abort', () => reject(timeout.signal.reason));
          }),
      }),
    );
    const pending = request('/rooms/x', identity);
    await Promise.resolve();
    timeout.abort(new DOMException('Timeout', 'TimeoutError'));
    await expect(pending).rejects.toMatchObject({ code: 'timeout', status: null });
  });
  it('preserves cancellation while reading a body', async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => {
          controller.abort();
          throw controller.signal.reason;
        },
      }),
    );
    const pending = request('/rooms/x', identity, { signal: controller.signal });
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
  it.each([null, { token: 'token', userId: 'bad', displayName: 'Ada' }])(
    'rejects invalid guest success data',
    async (body) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(body)));
      await expect(request('/sessions/guest', parseGuest)).rejects.toMatchObject({
        status: 200,
        code: 'invalid_response',
      });
    },
  );
  it('rejects invalid JSON and room fields in successful responses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('not JSON')));
    await expect(request('/rooms/x', parseRoom)).rejects.toMatchObject({
      code: 'invalid_response',
    });
    expect(() => parseRoom({ id: 'bad' })).toThrow();
  });
  it.each([
    '',
    'relative/path',
    'ftp://example.com',
    'https://user:secret@example.com',
    'http://example.com?key=x',
  ])('rejects invalid configuration %s', (url) => {
    expect(() => serviceUrl(url, 'VITE_API_BASE_URL')).toThrow('VITE_API_BASE_URL');
  });
});
