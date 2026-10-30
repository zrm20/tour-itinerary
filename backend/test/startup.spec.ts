import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module';

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'development');
  vi.stubEnv('PORT', undefined);
  vi.stubEnv('COMMIT_SHA', undefined);
  vi.stubEnv('DATABASE_URL', undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

it.each(['not-a-port', '', '0', '65536', '-1', '3000.5', '1e3', ' 3000 '])(
  'rejects invalid PORT %j at startup with a clear setting name',
  async (port) => {
    vi.stubEnv('PORT', port);

    await expect(
      Test.createTestingModule({ imports: [AppModule] })
        .compile()
        .then((module) => module.close()),
    ).rejects.toThrow('PORT must be an integer from 1 to 65535');
  },
);

it.each([undefined, '', 'local', '0123456', 'g'.repeat(40)])(
  'requires a full source SHA in production (COMMIT_SHA %j)',
  async (commit) => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('COMMIT_SHA', commit);

    await expect(
      Test.createTestingModule({ imports: [AppModule] })
        .compile()
        .then((module) => module.close()),
    ).rejects.toThrow(
      'COMMIT_SHA must be a full 40-character lowercase Git SHA',
    );
  },
);

it.each(['', 'prod'])('rejects an unknown NODE_ENV %j', async (nodeEnv) => {
  vi.stubEnv('NODE_ENV', nodeEnv);

  await expect(
    Test.createTestingModule({ imports: [AppModule] })
      .compile()
      .then((module) => module.close()),
  ).rejects.toThrow('NODE_ENV must be development, test, or production');
});
