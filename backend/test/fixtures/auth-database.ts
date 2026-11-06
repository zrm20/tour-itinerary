import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import pg from 'pg';
import { localTarget } from '../../scripts/database.mjs';

export async function authDatabase() {
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
  await admin.connect();
  const name = `it_test_${process.pid}`;
  await admin.query(`CREATE DATABASE ${name} OWNER it_migration`);
  const setupUrl = new URL(adminUrl);
  setupUrl.pathname = `/${name}`;
  const setup = new pg.Client({ connectionString: setupUrl.href });
  await setup.connect();
  try {
    for (const file of ['permissions.sql', 'shared-settings.sql']) {
      await setup.query(
        readFileSync(`database/${file}`, 'utf8').replaceAll(
          ':"database"',
          `"${name}"`,
        ),
      );
    }
  } finally {
    await setup.end();
  }
  const migration = new URL(setupUrl);
  migration.username = 'it_migration';
  migration.password = 'local-migration';
  const runtime = new URL(migration);
  runtime.username = 'it_runtime';
  runtime.password = 'local-runtime';
  execFileSync(process.execPath, ['scripts/database.mjs', 'deploy'], {
    env: { ...process.env, MIGRATION_DATABASE_URL: migration.href },
    stdio: 'pipe',
  });
  return {
    admin,
    name,
    migration: migration.href,
    runtime: runtime.href,
    async close() {
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end();
    },
  };
}
