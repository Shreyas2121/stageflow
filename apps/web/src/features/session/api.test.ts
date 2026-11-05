import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { changePassword, login, promote, register } from './api';
import { useSessionStore } from './session-store';

const session = {
  token: 'replacement-token',
  userId: '550e8400-e29b-41d4-a716-446655440000',
  displayName: 'Ava',
};
const routes = [
  {
    route: 'register',
    body: { displayName: 'Ava', email: 'ava@example.test', password: 'new-password' },
    protected: false,
    call: (signal?: AbortSignal) => register('Ava', 'ava@example.test', 'new-password', signal),
  },
  {
    route: 'login',
    body: { email: 'ava@example.test', password: 'new-password' },
    protected: false,
    call: (signal?: AbortSignal) => login('ava@example.test', 'new-password', signal),
  },
  {
    route: 'promote',
    body: { email: 'ava@example.test', password: 'new-password' },
    protected: true,
    call: (signal?: AbortSignal) =>
      promote('ava@example.test', 'new-password', 'current-token', signal),
  },
  {
    route: 'password',
    body: { currentPassword: 'old-password', password: 'new-password' },
    protected: true,
    call: (signal?: AbortSignal) =>
      changePassword('old-password', 'new-password', 'current-token', signal),
  },
];

beforeEach(() => {
  vi.stubEnv('VITE_API_BASE_URL', 'http://localhost:4000/api');
  vi.stubGlobal('sessionStorage', { setItem: vi.fn(), removeItem: vi.fn() });
  useSessionStore.getState().setSession({ ...session, token: 'current-token' });
});
afterEach(() => {
  useSessionStore.getState().clearSession();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it.each(routes)(
  'POST $route sends only its fields and the required bearer',
  async ({ route, body, protected: guarded, call }) => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ ...session, ignored: 'value' }));
    vi.stubGlobal('fetch', fetch);
    const controller = new AbortController();
    await expect(call(controller.signal)).resolves.toEqual(session);
    expect(fetch).toHaveBeenCalledExactlyOnceWith(`http://localhost:4000/api/sessions/${route}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(guarded ? { Authorization: 'Bearer current-token' } : {}),
      },
      body: JSON.stringify(body),
      signal: expect.any(AbortSignal),
    });
    const sent = fetch.mock.calls[0]![1] as RequestInit;
    controller.abort();
    expect(sent.signal?.aborted).toBe(true);
    expect(useSessionStore.getState().session?.token).toBe('current-token');
  },
);

it.each(routes)(
  'POST $route rejects an invalid session response without replacing storage',
  async ({ call }) => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(Response.json({ ...session, userId: 'invalid' })),
    );
    await expect(call()).rejects.toMatchObject({ code: 'invalid_response' });
    expect(useSessionStore.getState().session?.token).toBe('current-token');
  },
);

it.each(routes)(
  'POST $route preserves the API message and current session on failure',
  async ({ call, route }) => {
    const code =
      route === 'password'
        ? 'wrong_password'
        : route === 'promote'
          ? 'membership_active'
          : 'unauthorized';
    const status = route === 'promote' ? 409 : 401;
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ error: code, message: 'Account request refused.' }, { status }),
        ),
    );
    await expect(call()).rejects.toMatchObject({
      code,
      status,
      message: 'Account request refused.',
    });
    expect(useSessionStore.getState().session?.token).toBe('current-token');
  },
);

it.each(routes)('POST $route does no work after cancellation', async ({ call }) => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const controller = new AbortController();
  controller.abort();
  await expect(call(controller.signal)).rejects.toBe(controller.signal.reason);
  expect(fetch).not.toHaveBeenCalled();
});

it.each([
  null,
  [],
  {},
  { enabled: 'true' },
  { enabled: 1 },
  { enabled: true, secret: 'unexpected' },
  { enabled: false },
])('treats malformed or disabled Google probes as disabled: %j', async (body) => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(body)));
  const { googleEnabled } = await import('./api');
  expect(await googleEnabled()).toBe(false);
});
it('enables only the valid Google probe and hides failed probes', async () => {
  const { googleEnabled } = await import('./api');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ enabled: true })));
  expect(await googleEnabled()).toBe(true);
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
  expect(await googleEnabled()).toBe(false);
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(Response.json({ enabled: true }, { status: 503 })),
  );
  expect(await googleEnabled()).toBe(false);
});
it('redeems a Google ticket without a bearer and validates the session', async () => {
  const { redeemGoogleTicket } = await import('./api');
  const fetch = vi.fn().mockResolvedValue(Response.json(session));
  vi.stubGlobal('fetch', fetch);
  expect(await redeemGoogleTicket('one-time')).toEqual(session);
  expect(fetch).toHaveBeenCalledWith(
    'http://localhost:4000/api/sessions/google/ticket',
    expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ ticket: 'one-time' }),
      headers: { 'Content-Type': 'application/json' },
    }),
  );
});
it('links with the current bearer and accepts only Google authorization URLs', async () => {
  const { linkGoogle } = await import('./api');
  const fetch = vi
    .fn()
    .mockResolvedValue(
      Response.json({ url: 'https://accounts.google.com/o/oauth2/v2/auth?state=opaque' }),
    );
  vi.stubGlobal('fetch', fetch);
  expect(await linkGoogle('host-token')).toBe(
    'https://accounts.google.com/o/oauth2/v2/auth?state=opaque',
  );
  expect(fetch).toHaveBeenCalledWith(
    'http://localhost:4000/api/sessions/google/link',
    expect.objectContaining({ method: 'POST', headers: { Authorization: 'Bearer host-token' } }),
  );
  for (const url of [
    'https://evil.test',
    'javascript:alert(1)',
    'http://accounts.google.com/auth',
    'https://user@accounts.google.com/auth',
  ]) {
    fetch.mockResolvedValue(Response.json({ url }));
    await expect(linkGoogle('host-token')).rejects.toThrow('invalid response');
  }
});
