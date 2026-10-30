import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';

// Exercise the actual configured CEL condition's equality/and/list-membership
// subset with representative GitHub claims. Live Google IAM evaluation is a
// separate engineer acceptance step; this is not an OIDC integration test.
const configuration = readFileSync('../infra/main.tf', 'utf8');
const clauses = configuration.match(
  /attribute_condition = join\(" && ", \[([\s\S]*?)\]\)/,
)?.[1];
if (!clauses) throw new Error('Cannot locate federation policy');
const condition = clauses
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line.trim().replace(/,$/, '')) as string)
  .join(' && ')
  .replaceAll('${var.repository_id}', '123456789')
  .replaceAll('${var.owner_id}', '71274676')
  .replace(
    /assertion.event_name in (\[[^\]]+\])/,
    '$1.includes(assertion.event_name)',
  );
const allowed = {
  repository_id: '123456789',
  repository_owner_id: '71274676',
  ref: 'refs/heads/main',
  workflow_ref:
    'zrm20/tour-itinerary/.github/workflows/release.yml@refs/heads/main',
  event_name: 'workflow_run',
};
function accepts(overrides: Partial<typeof allowed>) {
  return runInNewContext(
    condition,
    { assertion: { ...allowed, ...overrides } },
    { timeout: 100 },
  ) as unknown;
}

it('allows the intended repository main release and main bootstrap dispatch', () => {
  expect(accepts({})).toBe(true);
  expect(accepts({ event_name: 'workflow_dispatch' })).toBe(true);
});

it.each([
  ['fork', { repository_id: '999999999' }],
  ['transferred repository', { repository_owner_id: '999999999' }],
  ['PR merge ref', { ref: 'refs/pull/10/merge', event_name: 'pull_request' }],
  ['PR target event on main', { event_name: 'pull_request_target' }],
  [
    'unrelated main workflow',
    {
      workflow_ref:
        'zrm20/tour-itinerary/.github/workflows/other.yml@refs/heads/main',
    },
  ],
  [
    'non-main dispatch',
    { ref: 'refs/heads/topic', event_name: 'workflow_dispatch' },
  ],
] as const)('denies %s credentials', (_name, claims) => {
  expect(accepts(claims)).toBe(false);
});
