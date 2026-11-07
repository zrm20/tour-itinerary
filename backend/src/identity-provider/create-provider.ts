import type { Database } from '../persistence/database';
import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { jwt } from 'better-auth/plugins';
import { oauthProvider } from '@better-auth/oauth-provider';
import { z } from 'zod';
import type { AuthConfig } from '../authentication/auth.config';
import type { UsersService } from '../users/users.service';

export function createProvider(
  config: AuthConfig,
  users: UsersService,
  persistence: Database,
) {
  const provision = async (user: {
    id: string;
    email: string;
    [key: string]: unknown;
  }) => {
    const profile = z
      .object({
        email: z.email(),
        firstName: z.string().trim().min(1).max(200),
        lastName: z.string().trim().min(1).max(200),
        preferredName: z.string().trim().min(1).max(200).nullish(),
      })
      .parse(user);
    await users.provision(config.issuer, user.id, profile);
  };
  return betterAuth({
    baseURL: config.issuer,
    basePath: '/auth',
    secret: config.secret,
    database: prismaAdapter(persistence.database, {
      provider: 'postgresql',
      transaction: true,
    }),
    trustedOrigins: [new URL(config.issuer).origin],
    logger: { disabled: true },
    onAPIError: { onError: () => undefined },
    emailAndPassword: { enabled: true, requireEmailVerification: false },
    account: { accountLinking: { enabled: false } },
    user: {
      additionalFields: {
        firstName: {
          type: 'string',
          required: true,
          validator: { input: z.string().trim().min(1).max(200) },
        },
        lastName: {
          type: 'string',
          required: true,
          validator: { input: z.string().trim().min(1).max(200) },
        },
        preferredName: {
          type: 'string',
          required: false,
          validator: { input: z.string().trim().min(1).max(200).optional() },
        },
      },
    },
    databaseHooks: {
      user: { create: { after: provision } },
      session: {
        create: {
          after: async (session) => {
            // Repair a provisioning failure before allowing another sign-in session.
            const user = await persistence.database.user.findUniqueOrThrow({
              where: { id: session.userId },
            });
            await provision(user);
          },
        },
      },
    },
    plugins: [
      {
        id: 'sanitize-auth-errors',
        onResponse: (response) => {
          if (response.status >= 500)
            return Promise.resolve({
              response: Response.json(
                { error: 'Authentication is unavailable' },
                { status: 503 },
              ),
            });
          return Promise.resolve();
        },
      },
      jwt({ jwks: { keyPairConfig: { alg: 'RS256' } } }),
      oauthProvider({
        loginPage: '/auth/login',
        consentPage: '/auth/consent',
        scopes: ['openid', 'profile', 'email'],
        grantTypes: ['authorization_code'],
        accessTokenExpiresIn: config.lifetime,
        // Provision resources and the trusted client only via explicit setup.
        allowDynamicClientRegistration: false,
        allowUnauthenticatedClientRegistration: false,
        clientPrivileges: () => false,
        resourcePrivileges: () => false,
      }),
    ],
    disabledPaths: [
      '/update-user',
      '/change-email',
      '/change-password',
      '/delete-user',
      '/request-password-reset',
      '/reset-password',
      '/link-social',
      '/token',
    ],
  });
}
