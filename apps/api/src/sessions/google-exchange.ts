import { OAuth2Client } from 'google-auth-library';
import { ApiException } from '../http/api.exception';
import type { ApiConfig } from '../config/parse-config';
import type { GoogleCodeExchange } from './google-identity';

export const googleRejected = () =>
  new ApiException(401, 'google_rejected', 'Google did not confirm this sign-in.');
export const googleUnavailable = () =>
  new ApiException(404, 'google_unavailable', 'Google sign-in is not configured.');
export type GoogleSettings = Pick<
  ApiConfig,
  | 'GOOGLE_ENABLED'
  | 'GOOGLE_CLIENT_ID'
  | 'GOOGLE_CLIENT_SECRET'
  | 'GOOGLE_REDIRECT_URI'
  | 'CORS_ORIGIN'
>;

export function createGoogleExchange(
  config: GoogleSettings,
  post: typeof fetch = fetch,
  verify: (
    token: string,
    audience: string,
  ) => Promise<{ sub?: unknown; name?: unknown } | undefined> = async (token, audience) =>
    (
      await new OAuth2Client({
        transporterOptions: { timeout: 10000, retry: false },
      }).verifyIdToken({ idToken: token, audience })
    ).getPayload(),
): GoogleCodeExchange {
  return async (code, verifier) => {
    if (!config.GOOGLE_ENABLED) throw googleUnavailable();
    try {
      const response = await post('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          code_verifier: verifier,
          client_id: config.GOOGLE_CLIENT_ID,
          client_secret: config.GOOGLE_CLIENT_SECRET,
          redirect_uri: config.GOOGLE_REDIRECT_URI,
          grant_type: 'authorization_code',
        }),
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw googleRejected();
      const data: unknown = await response.json();
      if (
        !data ||
        typeof data !== 'object' ||
        !('id_token' in data) ||
        typeof data.id_token !== 'string'
      )
        throw googleRejected();
      const profile = await verify(data.id_token, config.GOOGLE_CLIENT_ID);
      if (!profile || typeof profile.sub !== 'string' || !profile.sub) throw googleRejected();
      return { subject: profile.sub, name: typeof profile.name === 'string' ? profile.name : null };
    } catch {
      throw googleRejected();
    }
  };
}
