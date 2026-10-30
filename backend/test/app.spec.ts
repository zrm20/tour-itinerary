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
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  vi.unstubAllEnvs();
});

async function requestHealth(): Promise<Response> {
  const module = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  app = module.createNestApplication();
  await app.listen(0, '127.0.0.1');

  return fetch(`${await app.getUrl()}/health`, {
    signal: AbortSignal.timeout(2_000),
  });
}

it('serves the health contract over HTTP without database configuration', async () => {
  const response = await requestHealth();

  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('application/json');
  expect(await response.json()).toEqual({ status: 'ok', commit: 'local' });
});

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
