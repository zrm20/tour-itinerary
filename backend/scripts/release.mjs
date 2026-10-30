import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { appendFile } from 'node:fs/promises';
import process from 'node:process';
import { URL } from 'node:url';

const exec = promisify(execFile);
const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};
const shaPattern = /^[0-9a-f]{40}$/;
const wait = () => new Promise((resolve) => setTimeout(resolve, 2_000));
async function command(bin, args) {
  const { stdout } = await exec(bin, args, {
    timeout: 180_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout.trim();
}
async function json(bin, args) {
  return JSON.parse(await command(bin, args));
}
const repo = () => required('GITHUB_REPOSITORY');
const github = (path) => json('gh', ['api', `repos/${repo()}/${path}`]);

// Repeated immediately before any service mutation, including reruns.
async function eligible() {
  const run = await github(`actions/runs/${required('CI_RUN_ID')}`);
  if (
    run.event !== 'push' ||
    run.head_branch !== 'main' ||
    run.head_repository?.full_name !== repo() ||
    run.path !== '.github/workflows/ci.yml' ||
    run.status !== 'completed' ||
    run.conclusion !== 'success' ||
    !shaPattern.test(run.head_sha)
  )
    throw new Error(
      'Requires successful CI for a push to this repository main',
    );
  const head = await github('git/ref/heads/main');
  if (head.object.sha !== run.head_sha) return null;
  if (process.env.SOURCE_SHA && process.env.SOURCE_SHA !== run.head_sha) {
    throw new Error('Source SHA does not match checked CI run');
  }
  return run.head_sha;
}

async function prepare() {
  const sha = await eligible();
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(
      process.env.GITHUB_OUTPUT,
      `eligible=${Boolean(sha)}\nsha=${sha ?? ''}\n`,
    );
  }
  console.log(
    sha ? `Eligible checked main: ${sha}` : 'Skipped superseded main release',
  );
}

async function rollout() {
  const sha = required('SOURCE_SHA');
  const digest = required('IMAGE_DIGEST');
  const project = required('GCP_PROJECT');
  const service = required('CLOUD_RUN_SERVICE');
  const runId = required('GITHUB_RUN_ID');
  const attempt = required('GITHUB_RUN_ATTEMPT');
  if (!shaPattern.test(sha)) throw new Error('Invalid source commit');
  if (
    !new RegExp(
      `^us-east4-docker[.]pkg[.]dev/${project}/tour-itinerary/api@sha256:[0-9a-f]{64}$`,
    ).test(digest)
  ) {
    throw new Error('Invalid immutable image digest');
  }
  if (!/^[0-9]+$/.test(runId) || !/^[0-9]+$/.test(attempt))
    throw new Error('Invalid release identity');
  const suffix = `r${runId}-${attempt}`;
  const candidate = `${service}-${suffix}`;
  const tag = `candidate-${runId}-${attempt}`;
  const base = ['--project', project, '--region', 'us-east4', '--quiet'];
  const cloud = (args) => command('gcloud', [...args, ...base]);
  const describe = () =>
    json('gcloud', [
      'run',
      'services',
      'describe',
      service,
      ...base,
      '--format=json',
    ]);
  const revision = (name) =>
    json('gcloud', [
      'run',
      'revisions',
      'describe',
      name,
      ...base,
      '--format=json',
    ]);
  const report = {
    source: sha,
    digest,
    candidate,
    candidateUrl: null,
    serviceUrl: null,
    previous: null,
    checks: {},
    recovery: 'not needed',
    finalTraffic: null,
    workflow: `https://github.com/${repo()}/actions/runs/${runId}/attempts/${attempt}`,
    logs: `https://console.cloud.google.com/run/detail/us-east4/${service}/logs?project=${project}`,
  };
  const traffic = (state) =>
    (state.status?.traffic ?? []).filter((t) => Number(t.percent) > 0);
  const exclusively = (state, name) => {
    const targets = traffic(state);
    return (
      targets.length === 1 &&
      targets[0].revisionName === name &&
      Number(targets[0].percent) === 100
    );
  };
  async function settled(name) {
    let state;
    for (let count = 0; count < 6; count++) {
      state = await describe();
      report.finalTraffic = state.status?.traffic ?? [];
      if (
        exclusively(state, name) &&
        String(state.status.observedGeneration) ===
          String(state.metadata.generation)
      )
        return state;
      if (count < 5) await wait();
    }
    throw new Error(`Traffic did not settle exclusively on ${name}`);
  }
  async function health(url, commit, phase) {
    // Failure injection affects only the verifier, never the API or its data.
    if (process.env.FAIL_CHECK === phase) {
      report.checks[phase] = 'controlled failure';
      throw new Error(`Controlled ${phase} verification failure`);
    }
    try {
      await command(process.execPath, [
        new URL('./verify-health.mjs', import.meta.url).pathname,
        '--url',
        `${url}/health`,
        '--commit',
        commit,
      ]);
      report.checks[phase] = 'passed';
    } catch (error) {
      report.checks[phase] = 'failed';
      throw error;
    }
  }
  const updateTraffic = (name) =>
    cloud([
      'run',
      'services',
      'update-traffic',
      service,
      '--to-revisions',
      `${name}=100`,
    ]);
  let previous;
  let promotionAttempted = false;
  let mutationAttempted = false;
  try {
    if (!(await eligible())) {
      report.result = 'skipped superseded release';
      return;
    }
    const initial = await describe();
    report.serviceUrl = initial.status.url;
    const serving = traffic(initial);
    if (
      serving.length !== 1 ||
      Number(serving[0].percent) !== 100 ||
      !serving[0].revisionName
    ) {
      throw new Error(
        'Expected one explicit serving revision; reconcile manually before release',
      );
    }
    const old = await revision(serving[0].revisionName);
    const oldCommit = old.metadata.labels?.['source-commit'];
    const oldImage = old.spec.containers[0].image;
    if (
      !shaPattern.test(oldCommit ?? '') ||
      !/@sha256:[0-9a-f]{64}$/.test(oldImage)
    ) {
      throw new Error(
        'Serving revision lacks verified commit/digest metadata; follow bootstrap runbook',
      );
    }
    previous = {
      revision: serving[0].revisionName,
      commit: oldCommit,
      image: oldImage,
    };
    report.previous = previous;
    if (oldCommit === sha && process.env.FAIL_CHECK === 'none') {
      await settled(previous.revision);
      await health(report.serviceUrl, sha, 'current');
      report.result = 'already serving checked commit';
      return;
    }
    await health(report.serviceUrl, oldCommit, 'previous');
    // Protect fallback before creating any candidate; current remains protected too.
    await command('gcloud', [
      'artifacts',
      'docker',
      'tags',
      'add',
      oldImage,
      `us-east4-docker.pkg.dev/${project}/tour-itinerary/api:previous`,
      '--project',
      project,
      '--quiet',
    ]);
    if (!(await eligible())) {
      report.result = 'skipped superseded release';
      return;
    }
    // Remove only obsolete candidate tags, preserving explicit normal traffic.
    mutationAttempted = true;
    await cloud([
      'run',
      'services',
      'update-traffic',
      service,
      '--to-revisions',
      `${previous.revision}=100`,
      '--clear-tags',
    ]);
    await settled(previous.revision);
    await cloud([
      'run',
      'deploy',
      service,
      '--image',
      digest,
      '--no-traffic',
      '--revision-suffix',
      suffix,
      '--tag',
      tag,
      '--update-labels',
      `source-commit=${sha},release-id=${suffix}`,
    ]);
    const candidateState = await describe();
    const target = candidateState.status.traffic.find(
      (t) => t.tag === tag && t.revisionName === candidate,
    );
    if (!target?.url)
      throw new Error('Candidate tag did not resolve to expected revision');
    report.candidateUrl = target.url;
    await settled(previous.revision);
    await health(target.url, sha, 'candidate');
    promotionAttempted = true;
    let promotionError;
    try {
      await updateTraffic(candidate);
    } catch (error) {
      promotionError = String(error);
    }
    // A failed CLI may have succeeded server-side. Inspect actual converged traffic.
    await settled(candidate);
    if (promotionError)
      report.promotionReconciliation = `CLI failed but traffic converged: ${promotionError}`;
    await health(report.serviceUrl, sha, 'normal');
    await command('gcloud', [
      'artifacts',
      'docker',
      'tags',
      'add',
      digest,
      `us-east4-docker.pkg.dev/${project}/tour-itinerary/api:current`,
      '--project',
      project,
      '--quiet',
    ]);
    report.result = 'promoted and verified';
  } catch (error) {
    report.result = 'failed';
    report.error = String(error);
    process.exitCode = 1;
    if (mutationAttempted) {
      try {
        const actual = await describe();
        report.finalTraffic = actual.status?.traffic ?? [];
        if (!previous) {
          report.recovery =
            'NO FALLBACK: first deployment; engineer recovery required';
        } else if (
          promotionAttempted ||
          !exclusively(actual, previous.revision)
        ) {
          let rollbackError;
          try {
            await updateTraffic(previous.revision);
          } catch (failure) {
            rollbackError = String(failure);
          }
          await settled(previous.revision);
          await health(report.serviceUrl, previous.commit, 'rollback');
          report.recovery = 'previous revision restored and verified';
          if (rollbackError)
            report.rollbackReconciliation = `CLI failed but rollback verified: ${rollbackError}`;
        } else {
          await settled(previous.revision);
          await health(report.serviceUrl, previous.commit, 'preserved');
          report.recovery =
            'candidate failed; previous traffic preserved and verified';
        }
      } catch (failure) {
        report.recovery = `ROLLBACK/RECONCILIATION FAILED: ${String(failure)}; engineer recovery required`;
      }
    } else if (!previous) {
      report.recovery =
        'No service mutation; first bootstrap has no automatic fallback. Verify manually.';
    }
  } finally {
    try {
      report.finalTraffic = (await describe()).status?.traffic ?? [];
    } catch (error) {
      report.finalTrafficError = String(error);
    }
    const summary = `## Development release\n\n\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\`\n`;
    console.log(summary);
    if (process.env.GITHUB_STEP_SUMMARY)
      await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
  }
}

try {
  const mode = process.argv[2];
  if (mode === 'prepare') await prepare();
  else if (mode === 'rollout') await rollout();
  else throw new Error('Usage: release.mjs prepare|rollout');
} catch (error) {
  console.error(String(error));
  process.exitCode = 1;
}
