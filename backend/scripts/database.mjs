import { spawnSync } from 'node:child_process';
import pg from 'pg';

export function localTarget(value, kind) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${kind}: explicit database URL required`);
  }
  const name = url.pathname.slice(1);
  const allowed =
    kind === 'test-admin'
      ? name === 'it_admin'
      : kind === 'shadow'
        ? name === 'it_shadow'
        : name === 'it_local' || /^it_test_[0-9]+$/.test(name);
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.search ||
    url.hash ||
    !allowed
  ) {
    throw new Error(`${kind}: refusing shared or ambiguous target`);
  }
  return url;
}

async function main() {
  const command = process.argv[2];
  if (!['deploy', 'seed', 'dev', 'reset'].includes(command))
    throw new Error('Expected deploy, seed, dev, or reset');
  const url = localTarget(process.env.MIGRATION_DATABASE_URL, 'migration');
  if (url.username !== 'it_migration')
    throw new Error('Migration login must be it_migration');
  if (command === 'dev') {
    localTarget(process.env.SHADOW_DATABASE_URL, 'shadow');
    if (url.pathname !== '/it_local')
      throw new Error('Author migrations only against it_local');
  }
  if (command === 'reset' && url.pathname !== '/it_local')
    throw new Error('Reset is restricted to it_local');
  if (command === 'seed') {
    const client = new pg.Client({
      connectionString: url.href,
      connectionTimeoutMillis: 5000,
      query_timeout: 6000,
    });
    try {
      await client.connect();
      await client.query(
        'INSERT INTO infrastructure_fixture (key, message) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET message = EXCLUDED.message',
        ['infrastructure-probe', 'Infrastructure probe ready.'],
      );
    } finally {
      await client.end();
    }
  } else {
    const args = command === 'reset' ? ['reset', '--force'] : [command];
    const result = spawnSync(
      process.execPath,
      ['node_modules/prisma/build/index.js', 'migrate', ...args],
      { stdio: 'inherit', env: process.env },
    );
    if (result.error || result.status !== 0)
      throw new Error('Migration command failed');
  }
}

if (process.argv[1]?.endsWith('/database.mjs')) {
  main().catch(() => {
    console.error(
      'Database command failed; check isolated target configuration and migration state.',
    );
    process.exitCode = 1;
  });
}
