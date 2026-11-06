import { probeCapability } from './probe-capability.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { appendFile } from 'node:fs/promises';
import { boundedProcess } from './bounded-process.mjs';
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
async function persistenceCommand(operation, connection) {
  await boundedProcess('npm', ['run', `db:shared-${operation}`, '--silent'], {
    cwd: new URL('../', import.meta.url),
    env: { ...process.env, MIGRATION_DATABASE_URL: connection },
  });
}

function persistenceConfiguration(state) {
  const labels = state.metadata.labels ?? {};
  const legacy =
    !labels['persistence-mode'] && !labels['migration-secret-version'];
  const mode = legacy ? 'disabled' : labels['persistence-mode'];
  if (!['enabled', 'disabled'].includes(mode))
    throw new Error(
      'Missing or invalid Terraform persistence mode; reconcile service configuration',
    );
  const container = state.spec?.template?.spec?.containers?.[0];
  const runtime = (container?.env ?? []).filter(
    (entry) => entry.name === 'DATABASE_URL',
  );
  const version = labels['migration-secret-version'];
  if (mode === 'enabled') {
    const reference = runtime[0]?.valueFrom?.secretKeyRef;
    if (
      !/^[1-9][0-9]*$/.test(version ?? '') ||
      runtime.length !== 1 ||
      reference?.name !== 'api-runtime-database-url' ||
      !/^[1-9][0-9]*$/.test(reference?.key ?? '') ||
      runtime[0].value
    )
      throw new Error('Inconsistent activated persistence configuration');
    return { mode, version, runtimeVersion: reference.key };
  }
  // A legacy service without labels remains health-only, but a runtime setting
  // without activation metadata must never silently bypass migrations.
  if (runtime.length || (!legacy && version !== 'disabled'))
    throw new Error('Inconsistent disabled persistence configuration');
  return { mode };
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
    persistence: { mode: 'unknown', migration: 'not run', seed: 'not run' },
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
  async function health(url, commit, phase, probe = true) {
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
        '--probe',
        String(probe),
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
  async function protectImage(image, tag) {
    const imagePrefix = `us-east4-docker.pkg.dev/${project}/tour-itinerary/api@`;
    const version = image.slice(imagePrefix.length);
    if (
      !image.startsWith(imagePrefix) ||
      !/^sha256:[0-9a-f]{64}$/.test(version)
    )
      throw new Error(
        'Protection tags require an immutable image in this registry',
      );
    const parent = `projects/${project}/locations/us-east4/repositories/tour-itinerary/packages/api`;
    const name = `${parent}/tags/${tag}`;
    const targetVersion = `${parent}/versions/${version}`;
    const registry = [
      '--project',
      project,
      '--location',
      'us-east4',
      '--repository',
      'tour-itinerary',
      '--package',
      'api',
      '--quiet',
      '--format=json',
    ];
    const tags = await json('gcloud', [
      'artifacts',
      'tags',
      'list',
      ...registry,
      '--filter',
      `name=${name}`,
    ]);
    if (
      !Array.isArray(tags) ||
      tags.length > 1 ||
      (tags.length && tags[0].name !== name)
    )
      throw new Error(`Unexpected registry response for ${tag}`);
    if (tags[0]?.version === targetVersion) return;
    // Docker's tags add deletes existing tags; Writer supports direct updates.
    const updated = await json('gcloud', [
      'artifacts',
      'tags',
      tags.length ? 'update' : 'create',
      tag,
      '--version',
      version,
      ...registry,
    ]);
    if (updated.name !== name || updated.version !== targetVersion)
      throw new Error(`Registry did not confirm ${tag} image protection`);
  }
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
    // Inspect only the captured immutable digest, never latest/current service metadata.
    await command('docker', ['pull', oldImage]);
    const [imageMetadata] = await json('docker', [
      'image',
      'inspect',
      oldImage,
    ]);
    const supportsProbe = probeCapability(
      oldImage,
      oldCommit,
      imageMetadata?.Config?.Labels,
    );
    previous = {
      revision: serving[0].revisionName,
      commit: oldCommit,
      image: oldImage,
      supportsProbe,
    };
    report.previous = previous;
    const { mode, version, runtimeVersion } = persistenceConfiguration(initial);
    report.persistence.mode = mode;
    if (mode === 'enabled') {
      report.persistence.migrationSecret = `api-migration-database-url/versions/${version}`;
      report.persistence.runtimeSecret = `api-runtime-database-url/versions/${runtimeVersion}`;
    }
    if (
      mode === 'disabled' &&
      oldCommit === sha &&
      process.env.FAIL_CHECK === 'none'
    ) {
      await settled(previous.revision);
      await health(report.serviceUrl, sha, 'current');
      report.result = 'already serving checked commit';
      return;
    }
    await health(
      report.serviceUrl,
      oldCommit,
      'previous',
      previous.supportsProbe,
    );
    if (mode === 'enabled') {
      await command('npm', [
        'ci',
        '--prefix',
        new URL('../', import.meta.url).pathname,
        '--no-audit',
        '--no-fund',
      ]);
    }
    // Protect the captured serving image without replacing the prior rollback image.
    await protectImage(oldImage, 'current');
    if (!(await eligible())) {
      report.result = 'skipped superseded release';
      return;
    }
    report.persistence.eligibility =
      'current checked main before first database/service mutation';
    if (mode === 'enabled') {
      let connection;
      try {
        // Fetch only the explicitly selected version; never log stdout/errors.
        connection = await command('gcloud', [
          'secrets',
          'versions',
          'access',
          version,
          '--secret',
          'api-migration-database-url',
          '--project',
          project,
          '--quiet',
        ]);
      } catch {
        throw new Error(
          'Migration secret retrieval failed; inspect version/access privately',
        );
      }
      if (!(await eligible())) {
        report.result = 'skipped superseded release';
        report.persistence.eligibility =
          'superseded before first database mutation';
        return;
      }
      for (const operation of ['deploy', 'seed']) {
        const outcome = operation === 'deploy' ? 'migration' : 'seed';
        try {
          await persistenceCommand(operation, connection);
          report.persistence[outcome] = 'passed';
        } catch {
          report.persistence[outcome] =
            'failed; partial database changes may remain';
          throw new Error(
            `${outcome} failed; inspect actual database state before deliberate repair/retry`,
          );
        }
      }
      connection = undefined;
      if (oldCommit === sha && process.env.FAIL_CHECK === 'none') {
        await settled(previous.revision);
        await health(report.serviceUrl, sha, 'current');
        report.result = 'persistence verified; already serving checked commit';
        return;
      }
    }
    if (!(await eligible())) {
      report.result =
        'skipped superseded release after persistence; schema changes retained';
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
    await protectImage(previous.image, 'previous');
    await protectImage(digest, 'current');
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
          await health(
            report.serviceUrl,
            previous.commit,
            'rollback',
            previous.supportsProbe,
          );
          report.recovery = 'previous revision restored and verified';
          if (rollbackError)
            report.rollbackReconciliation = `CLI failed but rollback verified: ${rollbackError}`;
        } else {
          await settled(previous.revision);
          await health(
            report.serviceUrl,
            previous.commit,
            'preserved',
            previous.supportsProbe,
          );
          report.recovery =
            'candidate failed; previous traffic preserved and verified';
        }
      } catch (failure) {
        report.recovery = `ROLLBACK/RECONCILIATION FAILED: ${String(failure)}; engineer recovery required`;
      }
    } else if (previous) {
      report.recovery =
        'No service mutation; previous traffic unchanged. Database changes are not rolled back.';
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
