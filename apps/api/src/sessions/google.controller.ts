import { Body, Controller, Get, Headers, Inject, Post, Query, Res } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import type { Response } from 'express';
import { SessionsService } from './sessions.service';
import type { GoogleCodeExchange } from './google-identity';
import {
  GOOGLE_CONFIG,
  GOOGLE_EXCHANGE,
  GOOGLE_STATE,
  type GoogleState,
  type GoogleStateStore,
} from './google-state';
import { googleRejected, googleUnavailable, type GoogleSettings } from './google-exchange';
import { ApiException } from '../http/api.exception';

const randomToken = () => randomBytes(32).toString('base64url');
const opaqueToken = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);

@Controller('sessions/google')
export class GoogleController {
  constructor(
    @Inject(SessionsService) private readonly sessions: SessionsService,
    @Inject(GOOGLE_STATE) private readonly store: GoogleStateStore,
    @Inject(GOOGLE_EXCHANGE) private readonly exchange: GoogleCodeExchange,
    @Inject(GOOGLE_CONFIG) private readonly config: GoogleSettings,
  ) {}
  private configured(): void {
    if (!this.config.GOOGLE_ENABLED) throw googleUnavailable();
  }
  @Get()
  probe() {
    return { enabled: this.config.GOOGLE_ENABLED };
  }

  private async authorization(kind: 'sign-in' | 'link', userId?: string): Promise<string> {
    const state = randomToken();
    const verifier = randomToken();
    const value: GoogleState =
      kind === 'link' ? { kind, userId: userId!, verifier } : { kind, verifier };
    await this.store.putState(state, value);
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({
      client_id: this.config.GOOGLE_CLIENT_ID,
      redirect_uri: this.config.GOOGLE_REDIRECT_URI,
      response_type: 'code',
      scope: 'openid profile',
      state,
      code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    }).toString();
    return url.href;
  }
  @Get('start')
  async start(@Res() response: Response): Promise<void> {
    this.configured();
    response.redirect(await this.authorization('sign-in'));
  }
  @Post('link')
  async link(@Headers('authorization') authorization: string | undefined) {
    this.configured();
    const user = await this.sessions.verifyToken(/^Bearer (\S+)$/i.exec(authorization ?? '')?.[1]);
    if (user.isGuest)
      throw new ApiException(
        403,
        'google_host_required',
        'Create a host account before linking Google.',
      );
    return { url: await this.authorization('link', user.id) };
  }
  @Get('callback')
  async callback(
    @Query() query: Record<string, unknown>,
    @Res() response: Response,
  ): Promise<void> {
    this.configured();
    const target = new URL('/auth/google', this.config.CORS_ORIGIN);
    try {
      if (!opaqueToken(query.state)) throw googleRejected();
      const state = await this.store.takeState(query.state);
      if (
        !state ||
        query.error !== undefined ||
        typeof query.code !== 'string' ||
        !query.code ||
        query.code.length > 4096
      )
        throw googleRejected();
      const session = await this.sessions.exchangeGoogleCode(
        query.code,
        state.verifier,
        this.exchange,
        state.kind === 'link' ? state.userId : undefined,
      );
      if (state.kind === 'link') target.searchParams.set('linked', '1');
      else {
        const ticket = randomToken();
        await this.store.putTicket(ticket, session);
        target.searchParams.set('ticket', ticket);
      }
    } catch (error: unknown) {
      if (error instanceof ApiException && error.getStatus() === 503) throw error;
      const body = error instanceof ApiException ? error.getResponse() : null;
      target.searchParams.set(
        'error',
        typeof body === 'object' &&
          body !== null &&
          'error' in body &&
          body.error === 'google_linked'
          ? 'google_linked'
          : 'google_rejected',
      );
    }
    response.redirect(target.href);
  }
  @Post('ticket')
  async ticket(@Body() body: unknown) {
    this.configured();
    const key = body && typeof body === 'object' && 'ticket' in body ? body.ticket : undefined;
    if (!opaqueToken(key)) throw googleRejected();
    const session = await this.store.takeTicket(key);
    if (!session) throw googleRejected();
    return session;
  }
}
