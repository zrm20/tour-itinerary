import { execFileSync } from 'node:child_process';
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
  const owner = new pg.Client({
    connectionString: migrationUrl.href,
    connectionTimeoutMillis: 5000,
    query_timeout: 6000,
  });
  await owner.connect();
  await owner.query(`REVOKE ALL ON DATABASE ${database} FROM PUBLIC`);
  await owner.query(`GRANT CONNECT ON DATABASE ${database} TO it_runtime`);
  await owner.query('REVOKE ALL ON SCHEMA public FROM PUBLIC');
  await owner.query('GRANT USAGE ON SCHEMA public TO it_runtime');
  await owner.end();
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
