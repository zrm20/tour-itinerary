import { Body, Controller, Get, Next, Post, Req, Res } from '@nestjs/common';
import { Public } from '@nestjs/authentication';
import type { NextFunction, Request, Response } from 'express';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { z } from 'zod';
import { AppConfig } from '../app-config';
import { AuthConfig } from '../authentication/auth.config';
import { editorPage } from './editor-page';

const exchange = z.object({
  code: z.string().min(1).max(4096),
  verifier: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});

/** A public OIDC client. No credentials, provider sessions, or API privileges. */
@Public()
@Controller('graphql')
export class EditorController {
  private readonly clientId = process.env.GRAPHQL_OIDC_CLIENT_ID;
  private readonly keys;

  constructor(
    private readonly app: AppConfig,
    private readonly auth: AuthConfig,
  ) {
    this.keys = createRemoteJWKSet(new URL(`${auth.issuer}/jwks`));
  }

  private get options() {
    return this.auth.enabled && this.clientId
      ? {
          issuer: this.auth.issuer,
          audience: this.auth.audience,
          clientId: this.clientId,
          callback: `${new URL(this.auth.issuer).origin}/graphql/auth/callback`,
        }
      : null;
  }

  @Get()
  page(
    @Req() request: Request,
    @Res() response: Response,
    @Next() next: NextFunction,
  ) {
    if (
      !this.app.graphqlPlayground ||
      !request.headers.accept?.includes('text/html')
    )
      return next();
    this.sendPage(response);
  }

  @Get('auth/callback')
  callback(@Res() response: Response) {
    if (!this.app.graphqlPlayground || !this.options)
      return response.sendStatus(404);
    this.sendPage(response);
  }

  private sendPage(response: Response) {
    response
      .set({
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
      })
      .type('html')
      .send(editorPage(this.options));
  }

  private allowed(request: Request, response: Response) {
    response.set('Cache-Control', 'no-store');
    if (!this.app.graphqlPlayground || !this.options) {
      response.sendStatus(404);
      return false;
    }
    if (
      request.headers.origin !== new URL(this.auth.issuer).origin ||
      !request.is('application/json')
    ) {
      response.status(403).json({ error: 'Editor request rejected.' });
      return false;
    }
    return true;
  }

  @Post('auth/exchange')
  async exchange(
    @Req() request: Request,
    @Res() response: Response,
    @Body() body: unknown,
  ) {
    if (!this.allowed(request, response)) return;
    try {
      const { code, verifier, nonce } = exchange.parse(body);
      const result = await fetch(`${this.auth.issuer}/oauth2/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: this.clientId!,
          redirect_uri: this.options!.callback,
          resource: this.auth.audience,
          code,
          code_verifier: verifier,
        }),
        signal: AbortSignal.timeout(10000),
      });
      if (!result.ok) throw new Error('Exchange rejected');
      const tokens = z
        .object({
          access_token: z.string().min(1),
          id_token: z.string().min(1),
          token_type: z.literal('Bearer'),
        })
        .parse(await result.json());
      const { payload: identity } = await jwtVerify(
        tokens.id_token,
        this.keys,
        {
          issuer: this.auth.issuer,
          audience: this.clientId,
          algorithms: ['RS256'],
          requiredClaims: ['sub', 'exp', 'iat', 'nonce'],
        },
      );
      if (identity.nonce !== nonce) throw new Error('Nonce mismatch');
      const { payload: access } = await jwtVerify(
        tokens.access_token,
        this.keys,
        {
          issuer: this.auth.issuer,
          audience: this.auth.audience,
          algorithms: ['RS256'],
          typ: 'at+jwt',
          requiredClaims: ['sub', 'exp', 'iat', 'jti', 'client_id'],
        },
      );
      if (
        access.sub !== identity.sub ||
        access.client_id !== this.clientId ||
        access.cnf
      )
        throw new Error('Access token mismatch');
      response.json({
        accessToken: tokens.access_token,
        idToken: tokens.id_token,
        expiresAt: access.exp! * 1000,
      });
    } catch {
      response
        .status(400)
        .json({ error: 'Sign-in failed. Start sign-in again.' });
    }
  }

  @Post('auth/logout')
  async logout(
    @Req() request: Request,
    @Res() response: Response,
    @Body() body: unknown,
  ) {
    if (!this.allowed(request, response)) return;
    try {
      const { idToken } = z
        .object({ idToken: z.string().min(1).max(16384) })
        .parse(body);
      // The provider validates the logout hint, including expired ID tokens,
      // and ends only the session identified by that hint (same as the CLI).
      const result = await fetch(`${this.auth.issuer}/oauth2/end-session`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: this.clientId!,
          id_token_hint: idToken,
        }),
        signal: AbortSignal.timeout(10000),
      });
      await result.body?.cancel();
      if (!result.ok) throw new Error('Logout rejected');
      response.json({ signedOut: true });
    } catch {
      response
        .status(400)
        .json({ error: 'Provider sign-out failed. Retry sign-out.' });
    }
  }
}
