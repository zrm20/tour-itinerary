import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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
  } finally {
    await setup.end();
  }
  run('deploy');
  run('seed');
  persistence = new FixturePersistence(runtimeUrl.href);
}, 60000);
afterAll(async () => {
  await persistence?.close();
  await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
  await admin.end();
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
    expect(await persistence.read()).toEqual({
      message: 'Changed in PostgreSQL.',
    });
    await owner.query(
      "DELETE FROM infrastructure_fixture WHERE key = 'infrastructure-probe'",
    );
    expect(await persistence.read()).toBeNull();
    run('seed');
    expect(await persistence.read()).toEqual({
      message: 'Infrastructure probe ready.',
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
    await expect(persistence.read()).rejects.toThrow();
    expect(performance.now() - started).toBeLessThan(10000);
  } finally {
    await admin.query(`GRANT CONNECT ON DATABASE ${database} TO it_runtime`);
  }
  expect(await persistence.read()).toEqual({
    message: 'Infrastructure probe ready.',
  });
});

test('explicit reset and seed restore a readable fixture with runtime permissions', async () => {
  run('reset');
  run('seed');
  expect(await persistence.read()).toEqual({
    message: 'Infrastructure probe ready.',
  });
}, 60000);
