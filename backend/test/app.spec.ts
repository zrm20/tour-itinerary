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
  vi.stubEnv('GRAPHQL_PLAYGROUND', undefined);
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
