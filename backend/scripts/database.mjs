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
  const role = kind === 'test-admin' ? 'it_admin' : 'it_migration';
  const allowed =
    kind === 'test-admin'
      ? name === 'it_admin'
      : kind === 'shadow'
        ? name === 'it_shadow'
        : name === 'it_local' || /^it_test_[0-9]+$/.test(name);
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    url.username !== role ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.search ||
    url.hash ||
    !allowed
  ) {
    throw new Error(`${kind}: refusing shared or ambiguous target`);
  }
  return url;
}

// Shared targets have a separate non-destructive entry point. Local reset/dev
// guards remain unchanged and can never accept Neon URLs.
function sharedTarget(value) {
  const url = new URL(value);
  const keys = [...url.searchParams.keys()].sort().join(',');
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    url.username !== 'it_migration' ||
    !url.password ||
    !/^[a-z0-9.-]+[.]neon[.]tech$/.test(url.hostname) ||
    url.hostname.includes('-pooler') ||
    url.pathname !== '/tour_itinerary' ||
    (url.port && url.port !== '5432') ||
    url.hash ||
    keys !== 'connect_timeout,sslmode' ||
    url.searchParams.get('sslmode') !== 'verify-full' ||
    url.searchParams.get('connect_timeout') !== '10'
  )
    throw new Error('Refusing shared migration target');
  return url;
}

async function main() {
  const command = process.argv[2];
  const shared = ['shared-deploy', 'shared-seed'].includes(command);
  const operation = shared ? command.slice(7) : command;
  if (!['deploy', 'seed', 'dev', 'reset'].includes(operation))
    throw new Error('Expected deploy, seed, dev, or reset');
  const url = shared
    ? sharedTarget(process.env.MIGRATION_DATABASE_URL)
    : localTarget(process.env.MIGRATION_DATABASE_URL, 'migration');
  if (operation === 'dev') {
    localTarget(process.env.SHADOW_DATABASE_URL, 'shadow');
    if (url.pathname !== '/it_local')
      throw new Error('Author migrations only against it_local');
  }
  if (operation === 'seed') {
    const client = new pg.Client({
      connectionString: url.href,
      connectionTimeoutMillis: shared ? 10000 : 5000,
      statement_timeout: 5000,
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
    const args = operation === 'reset' ? ['reset', '--force'] : [operation];
    const result = spawnSync(
      process.execPath,
      ['node_modules/prisma/build/index.js', 'migrate', ...args],
      {
        stdio: shared ? 'pipe' : 'inherit',
        timeout: 120000,
        killSignal: 'SIGKILL',
        env: process.env,
      },
    );
    if (result.error || result.status !== 0)
      throw new Error('Migration command failed');
  }
}

if (process.argv[1]?.endsWith('/database.mjs')) {
  main().catch(() => {
    console.error(
      'Database command failed; inspect target configuration and actual migration state privately.',
    );
    process.exitCode = 1;
  });
}
