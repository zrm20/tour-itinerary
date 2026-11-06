import { Database } from '../persistence/database';
import { All, Controller, Get, Req, Res } from '@nestjs/common';
import { Public } from '@nestjs/authentication';
import type { Request, Response } from 'express';
import { toNodeHandler } from 'better-auth/node';
import { AuthConfig } from '../authentication/auth.config';
import { UsersService } from '../users/users.service';
import { createProvider } from './create-provider';

@Public()
@Controller('auth')
export class IdentityProviderController {
  private provider?: ReturnType<typeof createProvider>;
  private handler?: ReturnType<typeof toNodeHandler>;
  constructor(
    private readonly config: AuthConfig,
    private readonly users: UsersService,
    private readonly persistence: Database,
  ) {}

  @Get('.well-known/openid-configuration')
  async discovery(@Res() response: Response) {
    if (!this.config.enabled) {
      response.status(503).json({ error: 'Authentication is not configured' });
      return;
    }
    try {
      this.provider ??= createProvider(
        this.config,
        this.users,
        this.persistence,
      );
      response.json(await this.provider.api.getOpenIdConfig());
    } catch {
      response.status(503).json({ error: 'Authentication is unavailable' });
    }
  }

  @All('{*path}')
  async handle(@Req() request: Request, @Res() response: Response) {
    if (!this.config.enabled) {
      response.status(503).json({ error: 'Authentication is not configured' });
      return;
    }
    if (
      request.path.endsWith('/sign-up/email') &&
      request.body &&
      typeof request.body === 'object'
    ) {
      const body = request.body as Record<string, unknown>;
      // Better Auth's compatibility name is derived; registration requires only
      // the application names, never an extra name/username from the caller.
      body.name =
        typeof body.preferredName === 'string'
          ? body.preferredName
          : body.firstName;
    }
    try {
      this.provider ??= createProvider(
        this.config,
        this.users,
        this.persistence,
      );
      this.handler ??= toNodeHandler(this.provider);
      await this.handler(request, response);
    } catch {
      if (!response.headersSent)
        response.status(503).json({ error: 'Authentication is unavailable' });
    }
  }
}
