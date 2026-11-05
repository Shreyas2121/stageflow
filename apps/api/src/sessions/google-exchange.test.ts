import { expect, it, vi } from 'vitest';
import { createGoogleExchange } from './google-exchange';
const config = {
  GOOGLE_ENABLED: true,
  GOOGLE_CLIENT_ID: 'test-client',
  GOOGLE_CLIENT_SECRET: 'test-secret',
  GOOGLE_REDIRECT_URI: 'http://localhost/api/sessions/google/callback',
  CORS_ORIGIN: 'http://web.test',
};
it('posts the server credentials and PKCE verifier, verifies audience, and drops email', async () => {
  const post = vi.fn<typeof fetch>(async () =>
    Response.json({ id_token: 'verified-token', email: 'ignored@example.com' }),
  );
  const verify = vi.fn(async () => ({
    sub: 'subject',
    name: 'Name',
    email: 'ignored@example.com',
  }));
  expect(await createGoogleExchange(config, post, verify)('code', 'verifier')).toEqual({
    subject: 'subject',
    name: 'Name',
  });
  const [url, init] = post.mock.calls[0]!;
  expect(url).toBe('https://oauth2.googleapis.com/token');
  expect(init?.method).toBe('POST');
  expect(Object.fromEntries((init?.body as URLSearchParams).entries())).toEqual({
    code: 'code',
    code_verifier: 'verifier',
    client_id: config.GOOGLE_CLIENT_ID,
    client_secret: config.GOOGLE_CLIENT_SECRET,
    redirect_uri: config.GOOGLE_REDIRECT_URI,
    grant_type: 'authorization_code',
  });
  expect(init?.signal).toBeInstanceOf(AbortSignal);
  expect(verify).toHaveBeenCalledWith('verified-token', config.GOOGLE_CLIENT_ID);
});
it.each(['network', 'http', 'json', 'missing token', 'bad token', 'missing subject'])(
  'sanitizes %s failures',
  async (kind) => {
    const post = vi.fn<typeof fetch>(async () => {
      if (kind === 'network') throw new Error('private Google body');
      if (kind === 'http') return new Response('private Google body', { status: 400 });
      if (kind === 'json') return new Response('invalid json');
      return Response.json(kind === 'missing token' ? {} : { id_token: 'token' });
    });
    const verify = vi.fn(async () => {
      if (kind === 'bad token') throw new Error('private token details');
      return {};
    });
    await expect(
      createGoogleExchange(config, post, verify)('code', 'verifier'),
    ).rejects.toMatchObject({
      response: {
        statusCode: 401,
        error: 'google_rejected',
        message: 'Google did not confirm this sign-in.',
      },
    });
  },
);
it('refuses disabled exchange without network or verification', async () => {
  const post = vi.fn<typeof fetch>();
  const verify = vi.fn();
  await expect(
    createGoogleExchange({ ...config, GOOGLE_ENABLED: false }, post, verify)('code', 'verifier'),
  ).rejects.toMatchObject({ response: { error: 'google_unavailable' } });
  expect(post).not.toHaveBeenCalled();
  expect(verify).not.toHaveBeenCalled();
});
it('omits a missing or non-string profile name', async () => {
  const post = vi.fn<typeof fetch>(async () => Response.json({ id_token: 'token' }));
  expect(
    await createGoogleExchange(config, post, async () => ({ sub: 'subject', name: 42 }))(
      'code',
      'verifier',
    ),
  ).toEqual({ subject: 'subject', name: null });
});
