import process from 'node:process';

const defaults = { attempts: 15, delayMs: 2_000, timeoutMs: 2_000 };

function positiveInteger(values, name, fallback) {
  const value = values.get(name);
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || Number(value) < 1) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return Number(value);
}

function readArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith('--') || value === undefined) {
      throw new Error(`Invalid argument near ${name ?? '<end>'}`);
    }
    values.set(name.slice(2), value);
  }
  const url = values.get('url');
  const commit = values.get('commit');
  if (!url || !commit) {
    throw new Error('Usage: verify-health --url URL --commit FULL_SHA');
  }
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error('--commit must be a full 40-character lowercase Git SHA');
  }
  return {
    url,
    commit,
    probe: values.get('probe') === 'true',
    attempts: positiveInteger(values, 'attempts', defaults.attempts),
    delayMs: positiveInteger(values, 'delay-ms', defaults.delayMs),
    timeoutMs: positiveInteger(values, 'timeout-ms', defaults.timeoutMs),
  };
}

async function checkHealth({ url, commit, timeoutMs }) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'manual',
  });
  if (response.status !== 200) {
    throw new Error(`expected HTTP 200, received ${response.status}`);
  }
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error('response was not valid JSON');
  }
  if (body?.status !== 'ok') throw new Error('health status was not "ok"');
  if (body.commit !== commit) {
    throw new Error(`commit did not match expected ${commit}`);
  }
}

async function checkProbe({ url, timeoutMs }) {
  const response = await fetch(new URL('./graphql', url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: '{ infrastructureProbe { message } }' }),
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'manual',
  });
  if (response.status !== 200) throw new Error('probe expected HTTP 200');
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error('probe response was not valid JSON');
  }
  if (
    body?.errors !== undefined ||
    body?.data?.infrastructureProbe?.message !== 'Infrastructure probe ready.'
  )
    throw new Error('probe did not return canonical data without errors');
}

const delay = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function main() {
  const options = readArguments(process.argv.slice(2));
  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    try {
      await checkHealth(options);
      if (options.probe) await checkProbe(options);
      console.log(`Health verified for commit ${options.commit}`);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `Health attempt ${attempt}/${options.attempts} failed: ${message}`,
      );
      if (attempt < options.attempts) await delay(options.delayMs);
    }
  }
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
