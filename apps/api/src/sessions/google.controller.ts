import { Body, Controller, Get, Headers, Inject, Post, Query, Res } from '@nestjs/common';
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
import { GoogleBrowser, randomToken, opaqueToken, digest } from './google-browser';

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

  private async authorization(
    response: Response,
    kind: 'sign-in' | 'link',
    caller?: { userId: string; token: string },
  ): Promise<string> {
    const state = randomToken();
    const verifier = randomToken();
    const proof = randomToken();
    const browserHash = digest(proof);
    const value: GoogleState =
      kind === 'link'
        ? { kind, userId: caller!.userId, tokenHash: digest(caller!.token), verifier, browserHash }
        : { kind, verifier, browserHash };
    await this.store.putState(state, value);
    new GoogleBrowser(this.config).set(response, proof, 300_000);
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({
      client_id: this.config.GOOGLE_CLIENT_ID,
      redirect_uri: this.config.GOOGLE_REDIRECT_URI,
      response_type: 'code',
      scope: 'openid profile',
      state,
      code_challenge_method: 'S256',
      code_challenge: digest(verifier),
    }).toString();
    return url.href;
  }
  @Get('start')
  async start(@Res() response: Response): Promise<void> {
    this.configured();
    response.setHeader('Cache-Control', 'no-store');
    response.redirect(await this.authorization(response, 'sign-in'));
  }
  @Post('link')
  async link(
    @Headers('authorization') authorization: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    this.configured();
    const token = /^Bearer (\S+)$/i.exec(authorization ?? '')?.[1];
    const user = await this.sessions.verifyToken(token);
    if (user.isGuest)
      throw new ApiException(
        403,
        'google_host_required',
        'Create a host account before linking Google.',
      );
    response.setHeader('Cache-Control', 'no-store');
    return { url: await this.authorization(response, 'link', { userId: user.id, token: token! }) };
  }
  @Get('callback')
  async callback(
    @Query() query: Record<string, unknown>,
    @Res() response: Response,
    @Headers('cookie') cookie: string | undefined,
  ): Promise<void> {
    this.configured();
    const target = new URL('/auth/google', this.config.CORS_ORIGIN);
    const browser = new GoogleBrowser(this.config);
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    const proof = browser.proof(cookie);
    try {
      if (!opaqueToken(query.state)) throw googleRejected();
      const state = await this.store.takeState(query.state);
      if (
        !state ||
        !proof ||
        state.browserHash !== digest(proof) ||
        query.error !== undefined ||
        typeof query.code !== 'string' ||
        !query.code ||
        query.code.length > 4096
      )
        throw googleRejected();
      // Defer provider exchange and account mutation until the initiating browser
      // presents its proof and (for linking) the still-current initiating bearer.
      const ticket = randomToken();
      await this.store.putTicket(ticket, { code: query.code, state });
      browser.set(response, proof, 60_000);
      target.hash = new URLSearchParams({ ticket }).toString();
    } catch (error: unknown) {
      browser.clear(response);
      if (error instanceof ApiException && error.getStatus() === 503) throw error;
      target.searchParams.set('error', 'google_rejected');
    }
    response.redirect(target.href);
  }
  @Post('ticket')
  async ticket(
    @Body() body: unknown,
    @Headers('cookie') cookie: string | undefined,
    @Headers('authorization') authorization: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    this.configured();
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    const browser = new GoogleBrowser(this.config);
    const proof = browser.proof(cookie);
    browser.clear(response);
    const key = body && typeof body === 'object' && 'ticket' in body ? body.ticket : undefined;
    if (!opaqueToken(key)) throw googleRejected();
    const ticket = await this.store.takeTicket(key);
    if (!ticket || !ticket.state || !proof || ticket.state.browserHash !== digest(proof))
      throw googleRejected();
    const token = /^Bearer (\S+)$/i.exec(authorization ?? '')?.[1];
    if (ticket.state.kind === 'link' && (!token || digest(token) !== ticket.state.tokenHash))
      throw googleRejected();
    return this.sessions.exchangeGoogleCode(
      ticket.code,
      ticket.state.verifier,
      this.exchange,
      ticket.state.kind === 'link' ? token : undefined,
    );
  }
}
