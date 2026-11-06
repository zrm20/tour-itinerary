import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { execFileSync } from 'node:child_process';
import {
  readFileSync,
  mkdtempSync,
  cpSync,
  symlinkSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import pg from 'pg';
import { localTarget } from '../scripts/database.mjs';
import { FixturePersistence } from '../src/persistence/fixture-persistence';

// Explicit disposable target; never use the application or shared database.
const adminUrl = process.env.TEST_ADMIN_DATABASE_URL;
if (!adminUrl)
  throw new Error(
    'TEST_ADMIN_DATABASE_URL is required; see docs/persistence.md',
  );
localTarget(adminUrl, 'test-admin');
const admin = new pg.Client({
  connectionString: adminUrl,
  connectionTimeoutMillis: 5000,
  query_timeout: 6000,
});
const database = `it_test_${process.pid}`;
const migrationUrl = new URL(adminUrl);
migrationUrl.username = 'it_migration';
migrationUrl.password = 'local-migration';
migrationUrl.pathname = `/${database}`;
const runtimeUrl = new URL(migrationUrl);
runtimeUrl.username = 'it_runtime';
runtimeUrl.password = 'local-runtime';
let persistence: FixturePersistence;
let app: INestApplication;
let url: string;
async function probe() {
  const response = await fetch(`${url}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: '{ infrastructureProbe { message } }' }),
    signal: AbortSignal.timeout(10000),
  });
  expect(response.status).toBe(200);
  return response.json();
}
const run = (script: string) =>
  execFileSync(process.execPath, ['scripts/database.mjs', script], {
    env: { ...process.env, MIGRATION_DATABASE_URL: migrationUrl.href },
    stdio: 'pipe',
  });
beforeAll(async () => {
  await admin.connect();
  await admin.query(`CREATE DATABASE ${database} OWNER it_migration`);
  // Use the committed bootstrap SQL in the disposable target database.
  const setupUrl = new URL(adminUrl);
  setupUrl.pathname = `/${database}`;
  const setup = new pg.Client({ connectionString: setupUrl.href });
  await setup.connect();
  try {
    await setup.query(
      readFileSync('database/permissions.sql', 'utf8').replaceAll(
        ':"database"',
        `"${database}"`,
      ),
    );
    await setup.query(
      readFileSync('database/shared-settings.sql', 'utf8').replaceAll(
        ':"database"',
        `"${database}"`,
      ),
    );
  } finally {
    await setup.end();
  }
  run('deploy');
  run('seed');
  persistence = new FixturePersistence(runtimeUrl.href);
  const previousUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = runtimeUrl.href;
  try {
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication();
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
  } finally {
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
  }
}, 60000);
afterAll(async () => {
  await app?.close();
  await persistence?.close();
  await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
  await admin.end();
});
test('GraphQL reads the canonical fixture over real HTTP with runtime permissions', async () => {
  expect(await probe()).toEqual({
    data: { infrastructureProbe: { message: 'Infrastructure probe ready.' } },
  });
});

test('committed migrations and explicit seed make the fixture readable with runtime permissions', async () => {
  expect(await persistence.read()).toEqual({
    message: 'Infrastructure probe ready.',
  });
});

test('the next read reflects a changed message and missing fixture without repair', async () => {
  const owner = new pg.Client({
    connectionString: migrationUrl.href,
    connectionTimeoutMillis: 5000,
    query_timeout: 6000,
  });
  await owner.connect();
  try {
    await owner.query(
      "UPDATE infrastructure_fixture SET message = 'Changed in PostgreSQL.' WHERE key = 'infrastructure-probe'",
    );
    expect(await probe()).toEqual({
      data: { infrastructureProbe: { message: 'Changed in PostgreSQL.' } },
    });
    await owner.query(
      "DELETE FROM infrastructure_fixture WHERE key = 'infrastructure-probe'",
    );
    await expectProbeFailure();
    run('seed');
    expect(await probe()).toEqual({
      data: { infrastructureProbe: { message: 'Infrastructure probe ready.' } },
    });
  } finally {
    await owner.end();
  }
});

test('repeated seeds restore canonical text and preserve unrelated data', async () => {
  const owner = new pg.Client({
    connectionString: migrationUrl.href,
    connectionTimeoutMillis: 5000,
    query_timeout: 6000,
  });
  await owner.connect();
  try {
    await owner.query(
      "INSERT INTO infrastructure_fixture (key, message) VALUES ('unrelated', 'Keep me.')",
    );
    await owner.query(
      "UPDATE infrastructure_fixture SET message = 'Changed' WHERE key = 'infrastructure-probe'",
    );
    run('seed');
    run('seed');
    expect(await persistence.read()).toEqual({
      message: 'Infrastructure probe ready.',
    });
    expect(
      (
        await owner.query(
          "SELECT message FROM infrastructure_fixture WHERE key = 'unrelated'",
        )
      ).rows,
    ).toEqual([{ message: 'Keep me.' }]);
  } finally {
    await owner.end();
  }
});

test.each([
  "INSERT INTO infrastructure_fixture (key, message) VALUES ('forbidden', 'No')",
  "UPDATE infrastructure_fixture SET message = 'No'",
  'DELETE FROM infrastructure_fixture',
  'CREATE TABLE public.forbidden (id int)',
  'ALTER TABLE infrastructure_fixture ADD COLUMN forbidden int',
  'DROP TABLE infrastructure_fixture',
  'CREATE SCHEMA forbidden',
])('runtime cannot modify data or schema: %s', async (sql) => {
  const runtime = new pg.Client({
    connectionString: runtimeUrl.href,
    connectionTimeoutMillis: 5000,
    query_timeout: 6000,
  });
  await runtime.connect();
  try {
    await expect(runtime.query(sql)).rejects.toMatchObject({ code: '42501' });
  } finally {
    await runtime.end();
  }
});

test('connection failure is bounded and the same provider recovers after access returns', async () => {
  await admin.query(`REVOKE CONNECT ON DATABASE ${database} FROM it_runtime`);
  try {
    await admin.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND usename = $2',
      [database, 'it_runtime'],
    );
    const started = performance.now();
    await expectProbeFailure();
    const health = await fetch(`${url}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: 'ok', commit: 'local' });
    expect(performance.now() - started).toBeLessThan(10000);
  } finally {
    await admin.query(`GRANT CONNECT ON DATABASE ${database} TO it_runtime`);
  }
  expect(await probe()).toEqual({
    data: { infrastructureProbe: { message: 'Infrastructure probe ready.' } },
  });
});

test('already constructed runtime providers remain compatible after idempotent migration and seed', async () => {
  run('deploy');
  run('seed');
  expect(await persistence.read()).toEqual({
    message: 'Infrastructure probe ready.',
  });
});

test('a real failed seed reports failure and a deliberate repair restores reads', async () => {
  const owner = new pg.Client({ connectionString: migrationUrl.href });
  await owner.connect();
  try {
    await owner.query(
      'ALTER TABLE infrastructure_fixture RENAME TO temporarily_unavailable',
    );
    try {
      expect(() => run('seed')).toThrow('Database command failed');
    } finally {
      await owner.query(
        'ALTER TABLE temporarily_unavailable RENAME TO infrastructure_fixture',
      );
    }
    run('seed');
    expect(await persistence.read()).toEqual({
      message: 'Infrastructure probe ready.',
    });
  } finally {
    await owner.end();
  }
});

test('a failed migration can retain committed SQL while the previous runtime reader remains compatible', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'failed-migration-'));
  const owner = new pg.Client({ connectionString: migrationUrl.href });
  await owner.connect();
  try {
    // Copy source tooling; inject failure exclusively into this disposable DB.
    cpSync('prisma', join(directory, 'prisma'), { recursive: true });
    cpSync('prisma.config.ts', join(directory, 'prisma.config.ts'));
    mkdirSync(join(directory, 'scripts'));
    cpSync('scripts/database.mjs', join(directory, 'scripts/database.mjs'));
    symlinkSync(
      resolve('node_modules'),
      join(directory, 'node_modules'),
      'dir',
    );
    const migration = join(
      directory,
      'prisma/migrations/20990101000000_isolated_failure',
    );
    mkdirSync(migration);
    writeFileSync(
      join(migration, 'migration.sql'),
      'BEGIN; CREATE TABLE partial_fixture (id int); COMMIT; SELECT missing_column FROM infrastructure_fixture;',
    );
    expect(() =>
      execFileSync(process.execPath, ['scripts/database.mjs', 'deploy'], {
        cwd: directory,
        env: { ...process.env, MIGRATION_DATABASE_URL: migrationUrl.href },
        stdio: 'pipe',
      }),
    ).toThrow('Database command failed');
    expect(
      (
        await owner.query(
          "SELECT to_regclass('public.partial_fixture') AS name",
        )
      ).rows,
    ).toEqual([{ name: 'partial_fixture' }]);
    expect(await persistence.read()).toEqual({
      message: 'Infrastructure probe ready.',
    });
  } finally {
    // Deliberate isolated-test cleanup, never a shared recovery strategy.
    await owner.query('DROP TABLE IF EXISTS partial_fixture');
    await owner.query(
      "DELETE FROM _prisma_migrations WHERE migration_name = '20990101000000_isolated_failure'",
    );
    await owner.end();
    rmSync(directory, { recursive: true, force: true });
  }
}, 60000);

test('explicit reset and seed restore a readable fixture with runtime permissions', async () => {
  run('reset');
  run('seed');
  expect(await persistence.read()).toEqual({
    message: 'Infrastructure probe ready.',
  });
}, 60000);

async function expectProbeFailure() {
  expect(await probe()).toEqual({
    data: { infrastructureProbe: null },
    errors: [
      {
        message: 'Infrastructure probe unavailable.',
        locations: [{ line: 1, column: 3 }],
        path: ['infrastructureProbe'],
        extensions: { code: 'INFRASTRUCTURE_PROBE_FAILED' },
      },
    ],
  });
}

test('query failure is sanitized and recovers over HTTP without an API restart', async () => {
  const owner = new pg.Client({ connectionString: migrationUrl.href });
  await owner.connect();
  try {
    await owner.query(
      'ALTER TABLE infrastructure_fixture RENAME TO private_secret_table',
    );
    try {
      await expectProbeFailure();
    } finally {
      await owner.query(
        'ALTER TABLE private_secret_table RENAME TO infrastructure_fixture',
      );
    }
    expect(await probe()).toEqual({
      data: { infrastructureProbe: { message: 'Infrastructure probe ready.' } },
    });
  } finally {
    await owner.end();
  }
});

test('malformed GraphQL follows transport rules without echoing input', async () => {
  const response = await fetch(`${url}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: '{ private_secret' }),
  });
  expect(response.status).toBe(400);
  const body = await response.text();
  expect(body).toContain('GRAPHQL_REQUEST_FAILED');
  expect(body).not.toMatch(/private_secret|stacktrace|Prisma|postgresql/);
});
