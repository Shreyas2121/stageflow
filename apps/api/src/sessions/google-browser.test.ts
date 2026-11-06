import { expect, it, vi } from 'vitest';
import type { Response } from 'express';
import { GoogleBrowser } from './google-browser';
import type { GoogleSettings } from './google-exchange';

it('uses a host-only Secure HttpOnly cookie for HTTPS and rejects duplicate proofs', () => {
  const browser = new GoogleBrowser({
    GOOGLE_REDIRECT_URI: 'https://api.example.test/api/sessions/google/callback',
  } as GoogleSettings);
  const cookie = vi.fn();
  const response = { cookie } as unknown as Response;
  const proof = 'a'.repeat(43);
  browser.set(response, proof, 300000);
  expect(cookie).toHaveBeenCalledWith('__Host-stageflow-google', proof, {
    secure: true,
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 300000,
  });
  expect(browser.proof(`__Host-stageflow-google=${proof}`)).toBe(proof);
  expect(
    browser.proof(`__Host-stageflow-google=${proof}; __Host-stageflow-google=${proof}`),
  ).toBeUndefined();
  expect(browser.proof('stageflow-google-dev=' + proof)).toBeUndefined();
  browser.clear(response);
  expect(cookie).toHaveBeenLastCalledWith(
    '__Host-stageflow-google',
    '',
    expect.objectContaining({ maxAge: 0, secure: true }),
  );
});
