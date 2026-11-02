import { spawnSync } from 'node:child_process';
import { expect, test } from 'vitest';

test.each([
  'postgresql://it_migration:unused@shared.neon.tech/it_local',
  'postgresql://it_migration:unused@127.0.0.1:5432/production',
  'postgresql://it_migration:unused@127.0.0.1:5432/it_local?host=remote',
  '',
])('reset refuses a shared or ambiguous target before connecting', (url) => {
  const result = spawnSync(
    process.execPath,
    ['scripts/database.mjs', 'reset'],
    {
      env: { ...process.env, MIGRATION_DATABASE_URL: url },
      encoding: 'utf8',
    },
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('check isolated target configuration');
  expect(result.stderr).not.toContain('unused');
});
