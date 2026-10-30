import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import {
  mkdtemp,
  copyFile,
  chmod,
  readFile,
  writeFile,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { expect, it } from 'vitest';

const source = 'b'.repeat(40);
const previous = 'tour-itinerary-api-old';
const candidate = 'tour-itinerary-api-r123-1';
const digest = `us-east4-docker.pkg.dev/test-project/tour-itinerary/api@sha256:${'2'.repeat(64)}`;
type State = {
  url: string;
  traffic: { revisionName: string; percent: number }[];
};

async function simulate(
  scenario = 'success',
  failCheck = 'none',
  mode = 'rollout',
) {
  const directory = await mkdtemp(join(tmpdir(), 'delivery-'));
  const statePath = join(directory, 'state.json');
  const callsPath = join(directory, 'calls.txt');
  await writeFile(callsPath, '');
  const server = createServer((_request, response) => {
    void readFile(statePath, 'utf8').then((data) => {
      const state = JSON.parse(data) as State;
      const commit =
        _request.url?.startsWith('/candidate') ||
        state.traffic[0]?.revisionName === candidate ||
        scenario === 'already-current'
          ? source
          : 'a'.repeat(40);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: 'ok', commit }));
    });
  });
  try {
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('No test port');
    await writeFile(
      statePath,
      JSON.stringify({
        url: `http://127.0.0.1:${address.port}`,
        traffic: [{ revisionName: previous, percent: 100 }],
      }),
    );
    for (const name of ['gh', 'gcloud']) {
      await copyFile(
        resolve('test/fixtures/delivery-cli.mjs'),
        join(directory, name),
      );
      await chmod(join(directory, name), 0o755);
    }
    const child = spawn(
      process.execPath,
      [resolve('scripts/release.mjs'), mode],
      {
        env: {
          ...process.env,
          PATH: `${directory}:${process.env.PATH ?? ''}`,
          SIMULATION_STATE: statePath,
          SIMULATION_CALLS: callsPath,
          SIMULATION_SCENARIO: scenario,
          GITHUB_REPOSITORY: 'zrm20/tour-itinerary',
          CI_RUN_ID: '456',
          GITHUB_RUN_ID: '123',
          GITHUB_RUN_ATTEMPT: '1',
          SOURCE_SHA: source,
          IMAGE_DIGEST: digest,
          GCP_PROJECT: 'test-project',
          CLOUD_RUN_SERVICE: 'tour-itinerary-api',
          FAIL_CHECK: failCheck,
          GITHUB_STEP_SUMMARY: '',
          GITHUB_OUTPUT: '',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    const exitCode = await new Promise<number | null>((done) =>
      child.once('close', done),
    );
    return {
      exitCode,
      output,
      calls: await readFile(callsPath, 'utf8'),
      state: JSON.parse(await readFile(statePath, 'utf8')) as State,
    };
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
    await rm(directory, { recursive: true, force: true });
  }
}

it('promotes an explicitly verified immutable candidate without rebuilding', async () => {
  const result = await simulate();
  expect(result.exitCode).toBe(0);
  expect(result.state.traffic).toEqual([
    { revisionName: candidate, percent: 100 },
  ]);
  expect(result.calls).toContain(`--image ${digest} --no-traffic`);
  expect(result.calls).toContain(`--to-revisions ${previous}=100 --clear-tags`);
  expect(result.output).toContain('promoted and verified');
  expect(result.output).toContain('"candidate": "passed"');
  expect(result.output).toContain('"normal": "passed"');
  expect(result.calls).not.toContain('build');
});

it.each(['pr', 'fork', 'other-workflow', 'failed-ci'])(
  'rejects untrusted or unchecked CI source: %s',
  async (scenario) => {
    const result = await simulate(scenario, 'none', 'prepare');
    expect(result.exitCode).toBe(1);
    expect(result.calls).not.toContain('gcloud');
  },
);

it('skips a stale rerun before any service mutation', async () => {
  const result = await simulate('stale');
  expect(result.exitCode).toBe(0);
  expect(result.output).toContain('skipped superseded release');
  expect(result.calls).not.toContain('run deploy');
  expect(result.calls).not.toContain('update-traffic');
});

it('rechecks main eligibility immediately before service mutation', async () => {
  const result = await simulate('superseded');
  expect(result.exitCode).toBe(0);
  expect(result.output).toContain('skipped superseded release');
  expect(result.calls).not.toContain('run deploy');
  expect(result.calls).not.toContain('update-traffic');
});

it('does not mutate a rerun already serving the checked commit', async () => {
  const result = await simulate('already-current');
  expect(result.exitCode).toBe(0);
  expect(result.calls).not.toContain('update-traffic');
  expect(result.calls).not.toContain('run deploy');
  expect(result.output).toContain('already serving checked commit');
});

it('preserves traffic when candidate health fails', async () => {
  const result = await simulate('success', 'candidate');
  expect(result.exitCode).toBe(1);
  expect(result.state.traffic).toEqual([
    { revisionName: previous, percent: 100 },
  ]);
  expect(result.calls).not.toContain(`--to-revisions ${candidate}=100`);
  expect(result.output).toContain('previous traffic preserved and verified');
});

it('reconciles a candidate creation timeout without moving normal traffic', async () => {
  const result = await simulate('deploy-timeout');
  expect(result.exitCode).toBe(1);
  expect(result.state.traffic).toEqual([
    { revisionName: previous, percent: 100 },
  ]);
  expect(result.output).toContain('previous traffic preserved and verified');
});

it('reconciles a promotion timeout that changed traffic and verifies success', async () => {
  const result = await simulate('promotion-timeout');
  expect(result.exitCode).toBe(0);
  expect(result.state.traffic).toEqual([
    { revisionName: candidate, percent: 100 },
  ]);
  expect(result.output).toContain('CLI failed but traffic converged');
});

it('restores and verifies the explicit previous commit after normal URL failure', async () => {
  const result = await simulate('success', 'normal');
  expect(result.exitCode).toBe(1);
  expect(result.state.traffic).toEqual([
    { revisionName: previous, percent: 100 },
  ]);
  expect(result.output).toContain('previous revision restored and verified');
  expect(result.output).toContain('"rollback": "passed"');
});

it('reconciles an ambiguous rollback CLI failure against actual traffic', async () => {
  const result = await simulate('rollback-timeout', 'normal');
  expect(result.exitCode).toBe(1);
  expect(result.state.traffic).toEqual([
    { revisionName: previous, percent: 100 },
  ]);
  expect(result.output).toContain('CLI failed but rollback verified');
});

it('reports failure when promotion never takes effect, even after verified recovery', async () => {
  const result = await simulate('promotion-rejected');
  expect(result.exitCode).toBe(1);
  expect(result.state.traffic).toEqual([
    { revisionName: previous, percent: 100 },
  ]);
  expect(result.output).toContain('previous revision restored and verified');
}, 30_000);

it('reports rollback failure separately and includes actual final candidate traffic', async () => {
  const result = await simulate('rollback-fails', 'normal');
  expect(result.exitCode).toBe(1);
  expect(result.state.traffic).toEqual([
    { revisionName: candidate, percent: 100 },
  ]);
  expect(result.output).toContain('ROLLBACK/RECONCILIATION FAILED');
  expect(result.output).toContain('"finalTraffic"');
}, 30_000);

it('reports the missing first service without deploying or inventing a fallback', async () => {
  const result = await simulate('no-service');
  expect(result.exitCode).toBe(1);
  expect(result.calls).not.toContain('run deploy');
  expect(result.calls).not.toContain('update-traffic');
  expect(result.output).toContain('first bootstrap has no automatic fallback');
});
