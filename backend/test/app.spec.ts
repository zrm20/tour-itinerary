import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module';

let app: INestApplication | undefined;

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'development');
  vi.stubEnv('PORT', undefined);
  vi.stubEnv('COMMIT_SHA', undefined);
  vi.stubEnv('DATABASE_URL', undefined);
  vi.stubEnv('AUTH_ISSUER', undefined);
  vi.stubEnv('GRAPHQL_PLAYGROUND', undefined);
  vi.stubEnv('GRAPHQL_OIDC_CLIENT_ID', undefined);
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  vi.unstubAllEnvs();
});

async function startApp(): Promise<string> {
  const module = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  app = module.createNestApplication();
  await app.listen(0, '127.0.0.1');

  return app.getUrl();
}

async function requestHealth(): Promise<Response> {
  return fetch(`${await startApp()}/health`, {
    signal: AbortSignal.timeout(2_000),
  });
}

it('serves the health contract over HTTP without database configuration', async () => {
  const response = await requestHealth();

  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('application/json');
  expect(await response.json()).toEqual({ status: 'ok', commit: 'local' });
});

it.each([
  ['development', undefined, false],
  ['development', 'false', false],
  ['development', 'true', true],
  ['production', undefined, false],
  ['production', 'true', true],
] as const)(
  'serves the browser query editor only when enabled (NODE_ENV=%s, GRAPHQL_PLAYGROUND=%s)',
  async (nodeEnv, playground, enabled) => {
    vi.stubEnv('NODE_ENV', nodeEnv);
    vi.stubEnv('COMMIT_SHA', '0123456789abcdef0123456789abcdef01234567');
    vi.stubEnv('GRAPHQL_PLAYGROUND', playground);

    const response = await fetch(`${await startApp()}/graphql`, {
      headers: { accept: 'text/html' },
      signal: AbortSignal.timeout(2_000),
    });
    const body = await response.text();

    if (enabled) {
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/html');
      expect(body).toContain('GraphiQL');
    } else {
      expect(response.status).toBe(400);
      expect(body).not.toContain('GraphiQL');
    }
  },
);

it('returns only status and the full source SHA in production', async () => {
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('COMMIT_SHA', '0123456789abcdef0123456789abcdef01234567');
  vi.stubEnv('UNRELATED_SETTING', 'must-not-be-exposed');

  const response = await requestHealth();

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    status: 'ok',
    commit: '0123456789abcdef0123456789abcdef01234567',
  });
});

it('reports the login page as unavailable when authentication is not configured', async () => {
  const response = await fetch(`${await startApp()}/auth/login`, {
    headers: { accept: 'text/html' },
    signal: AbortSignal.timeout(2_000),
  });

  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({
    error: 'Authentication is not configured',
  });
});

it('starts and serves health with authentication configured and PostgreSQL unavailable', async () => {
  vi.stubEnv('AUTH_ISSUER', 'http://127.0.0.1:3000/auth');
  vi.stubEnv('AUTH_SECRET', 'test-only-secret-at-least-thirty-two-characters');
  vi.stubEnv(
    'DATABASE_URL',
    'postgresql://unavailable:unavailable@127.0.0.1:1/unavailable',
  );
  const response = await requestHealth();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: 'ok', commit: 'local' });
});

it.each([
  [false, true, true],
  [true, false, true],
  [true, true, false],
  [true, true, true],
])(
  'gates editor authentication without touching PostgreSQL (editor=%s, auth=%s, client=%s)',
  async (editor, auth, client) => {
    vi.stubEnv('GRAPHQL_PLAYGROUND', String(editor));
    vi.stubEnv('GRAPHQL_OIDC_CLIENT_ID', client ? 'editor-client' : undefined);
    if (auth) {
      vi.stubEnv('AUTH_ISSUER', 'http://127.0.0.1:3000/auth');
      vi.stubEnv(
        'AUTH_SECRET',
        'test-only-secret-at-least-thirty-two-characters',
      );
      vi.stubEnv(
        'DATABASE_URL',
        'postgresql://unavailable:unavailable@127.0.0.1:1/unavailable',
      );
    }
    const origin = await startApp();
    const configured = editor && auth && client;
    const callback = await fetch(
      `${origin}/graphql/auth/callback?error=access_denied&state=untrusted`,
      { headers: { accept: 'text/html' } },
    );
    expect(callback.status).toBe(configured ? 200 : 404);
    const body = await callback.text();
    expect(body).not.toContain('untrusted');
    if (!configured) {
      for (const path of ['exchange', 'logout']) {
        const response = await fetch(`${origin}/graphql/auth/${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin },
          body: '{}',
        });
        expect(response.status).toBe(404);
      }
    }
    if (editor && !configured) {
      const page = await fetch(`${origin}/graphql`, {
        headers: { accept: 'text/html' },
      });
      expect(await page.text()).toContain('const options = null');
    }
    const publicQuery = await fetch(`${origin}/graphql`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: '{ __typename }' }),
    });
    expect(await publicQuery.json()).toEqual({ data: { __typename: 'Query' } });
    expect((await fetch(`${origin}/health`)).status).toBe(200);
  },
);
