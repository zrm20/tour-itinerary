#!/usr/bin/env node
// External GitHub/Cloud Run simulator used by the public release-command tests.
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { basename } from 'node:path';
import process from 'node:process';

const [bin, ...args] = process.argv.slice(1);
const state = JSON.parse(readFileSync(process.env.SIMULATION_STATE, 'utf8'));
appendFileSync(
  process.env.SIMULATION_CALLS,
  `${basename(bin)} ${args.join(' ')}\n`,
);
const scenario = process.env.SIMULATION_SCENARIO;
const print = (value) => console.log(JSON.stringify(value));
const save = () =>
  writeFileSync(process.env.SIMULATION_STATE, JSON.stringify(state));
const fail = () => {
  console.error('Simulated ambiguous CLI failure');
  process.exitCode = 1;
};
const flag = (name) => args[args.indexOf(name) + 1];
const old = 'tour-itinerary-api-old';
const candidate = 'tour-itinerary-api-r123-1';

if (basename(bin) === 'gh') {
  if (args[1].includes('actions/runs')) {
    print({
      event: scenario === 'pr' ? 'pull_request' : 'push',
      head_branch: 'main',
      head_repository: {
        full_name:
          scenario === 'fork' ? 'fork/tour-itinerary' : 'zrm20/tour-itinerary',
      },
      path:
        scenario === 'other-workflow'
          ? '.github/workflows/other.yml'
          : '.github/workflows/ci.yml',
      status: 'completed',
      conclusion: scenario === 'failed-ci' ? 'failure' : 'success',
      head_sha: 'b'.repeat(40),
    });
  } else {
    state.headReads = (state.headReads ?? 0) + 1;
    save();
    print({
      object: {
        sha:
          scenario === 'stale' ||
          (scenario === 'superseded' && state.headReads > 1)
            ? 'c'.repeat(40)
            : 'b'.repeat(40),
      },
    });
  }
} else if (args[0] === 'artifacts') {
  // Registry changes do not affect serving traffic.
} else if (args.includes('describe') && args.includes('services')) {
  if (scenario === 'no-service') fail();
  else
    print({
      metadata: { generation: '1' },
      status: {
        observedGeneration: '1',
        url: state.url,
        traffic: [
          ...state.traffic,
          ...(state.tagged
            ? [
                {
                  revisionName: candidate,
                  tag: 'candidate-123-1',
                  url: `${state.url}/candidate`,
                },
              ]
            : []),
        ],
      },
    });
} else if (args.includes('revisions')) {
  print({
    metadata: {
      labels: {
        'source-commit':
          scenario === 'already-current' ? 'b'.repeat(40) : 'a'.repeat(40),
      },
    },
    spec: {
      containers: [
        {
          image: `us-east4-docker.pkg.dev/test-project/tour-itinerary/api@sha256:${'1'.repeat(64)}`,
        },
      ],
    },
  });
} else if (args.includes('deploy')) {
  state.tagged = true;
  save();
  if (scenario === 'deploy-timeout') fail();
} else if (args.includes('update-traffic')) {
  const name = flag('--to-revisions').split('=')[0];
  if (args.includes('--clear-tags')) state.tagged = false;
  if (
    (scenario === 'promotion-rejected' && name === candidate) ||
    (scenario === 'rollback-fails' &&
      name === old &&
      state.traffic[0].revisionName === candidate)
  ) {
    fail();
  } else {
    state.traffic = [{ revisionName: name, percent: 100 }];
    save();
    if (scenario === 'promotion-timeout' && name === candidate) fail();
    if (
      scenario === 'rollback-timeout' &&
      name === old &&
      !args.includes('--clear-tags')
    )
      fail();
  }
} else {
  console.error(`Unexpected simulated command: ${args.join(' ')}`);
  process.exitCode = 2;
}
