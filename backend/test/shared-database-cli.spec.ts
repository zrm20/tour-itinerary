import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

// Every URL here is rejected before a connection. No valid deploy target is used.
const invalidTargets = [
  'postgresql://it_migration:private-password@ep-test-pooler.us-east-1.aws.neon.tech/tour_itinerary?sslmode=verify-full&connect_timeout=10',
  'postgresql://it_runtime:private-password@ep-test.us-east-1.aws.neon.tech/tour_itinerary?sslmode=verify-full&connect_timeout=10',
  'postgresql://it_migration:private-password@ep-test.us-east-1.aws.neon.tech/it_local?sslmode=verify-full&connect_timeout=10',
  'postgresql://it_migration:private-password@ep-test.us-east-1.aws.neon.tech/tour_itinerary?sslmode=require&connect_timeout=10',
  'postgresql://it_migration:private-password@ep-test.us-east-1.aws.neon.tech/tour_itinerary?sslmode=verify-full&connect_timeout=0',
  'postgresql://it_migration:private-password@ep-test.us-east-1.aws.neon.tech/tour_itinerary?sslmode=verify-full&connect_timeout=10&options=-c%20search_path%3Dother',
  'postgresql://it_migration:private-password@127.0.0.1/tour_itinerary?sslmode=verify-full&connect_timeout=10',
  'not-a-url-private-password',
];
it.each(invalidTargets)(
  'refuses invalid shared URL without exposing credentials: %s',
  (connection) => {
    const result = spawnSync(
      process.execPath,
      ['scripts/database.mjs', 'shared-deploy'],
      {
        env: { ...process.env, MIGRATION_DATABASE_URL: connection },
        encoding: 'utf8',
        timeout: 5000,
      },
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(
      'Database command failed; inspect target configuration and actual migration state privately.\n',
    );
    expect(result.stderr).not.toContain('private-password');
  },
);

it.each(['reset', 'dev', 'shared-reset', 'shared-dev'])(
  'cannot reset or author migrations against a nonlocal target: %s',
  (operation) => {
    const result = spawnSync(
      process.execPath,
      ['scripts/database.mjs', operation],
      {
        env: { ...process.env, MIGRATION_DATABASE_URL: invalidTargets[0] },
        encoding: 'utf8',
        timeout: 5000,
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Database command failed');
    expect(result.stderr).not.toContain('private-password');
  },
);
