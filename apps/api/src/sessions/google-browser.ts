import { createHash, randomBytes } from 'node:crypto';
import type { Response } from 'express';
import type { GoogleSettings } from './google-exchange';

export const opaqueToken = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
export const randomToken = () => randomBytes(32).toString('base64url');
export const digest = (value: string) => createHash('sha256').update(value).digest('base64url');

export class GoogleBrowser {
  private readonly secure: boolean;
  private readonly name: string;
  constructor(config: GoogleSettings) {
    this.secure = new URL(config.GOOGLE_REDIRECT_URI).protocol === 'https:';
    this.name = this.secure ? '__Host-stageflow-google' : 'stageflow-google-dev';
  }

  proof(cookie: string | undefined): string | undefined {
    const values = (cookie ?? '')
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s.startsWith(`${this.name}=`))
      .map((s) => s.slice(this.name.length + 1));
    return values.length === 1 && opaqueToken(values[0]) ? values[0] : undefined;
  }

  set(response: Response, proof: string, maxAge: number): void {
    response.cookie(this.name, proof, {
      httpOnly: true,
      secure: this.secure,
      sameSite: 'lax',
      path: '/',
      maxAge,
    });
  }

  clear(response: Response): void {
    this.set(response, '', 0);
  }
}
