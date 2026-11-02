import process from 'node:process';
import { Buffer } from 'node:buffer';
import { URL } from 'node:url';

class ProbeFailure extends Error {}

function required(name) {
  const value = process.env[name];
  if (!value)
    throw new ProbeFailure(`Missing ${name}; live rejection was not tested`);
  return value;
}

async function main() {
  const provider = required('WORKLOAD_IDENTITY_PROVIDER');
  if (
    !/^projects\/\d+\/locations\/global\/workloadIdentityPools\/[^/]+\/providers\/[^/]+$/.test(
      provider,
    )
  )
    throw new ProbeFailure('Invalid workload identity provider resource');
  const tokenUrl = new URL(required('ACTIONS_ID_TOKEN_REQUEST_URL'));
  if (
    tokenUrl.protocol !== 'https:' ||
    !tokenUrl.hostname.endsWith('.actions.githubusercontent.com')
  )
    throw new ProbeFailure('Unexpected GitHub OIDC request host');
  tokenUrl.searchParams.set(
    'audience',
    `https://iam.googleapis.com/${provider}`,
  );
  const issued = await fetch(tokenUrl, {
    headers: {
      Authorization: `Bearer ${required('ACTIONS_ID_TOKEN_REQUEST_TOKEN')}`,
    },
    signal: AbortSignal.timeout(15_000),
    redirect: 'error',
  });
  if (!issued.ok)
    throw new ProbeFailure(
      `GitHub OIDC issuance failed (HTTP ${issued.status}); Google rejection was not tested`,
    );
  const { value: token } = await issued.json();
  if (typeof token !== 'string' || token.split('.').length !== 3)
    throw new ProbeFailure('GitHub did not issue a JWT');
  const claims = JSON.parse(
    Buffer.from(token.split('.')[1], 'base64url').toString('utf8'),
  );
  for (const [claim, variable] of [
    ['repository', 'GITHUB_REPOSITORY'],
    ['ref', 'GITHUB_REF'],
    ['workflow_ref', 'GITHUB_WORKFLOW_REF'],
    ['event_name', 'GITHUB_EVENT_NAME'],
  ]) {
    if (claims[claim] !== required(variable))
      throw new ProbeFailure(`Issued token did not match this job's ${claim}`);
  }
  console.log(
    JSON.stringify(
      {
        repository: claims.repository,
        ref: claims.ref,
        workflow_ref: claims.workflow_ref,
        event_name: claims.event_name,
      },
      null,
      2,
    ),
  );
  // Google validates the token's signature; tokens and credential bodies stay in memory.
  const exchanged = await fetch('https://sts.googleapis.com/v1/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      audience: `//iam.googleapis.com/${provider}`,
      grantType: 'urn:ietf:params:oauth:grant-type:token-exchange',
      requestedTokenType: 'urn:ietf:params:oauth:token-type:access_token',
      scope: 'https://www.googleapis.com/auth/cloud-platform',
      subjectTokenType: 'urn:ietf:params:oauth:token-type:jwt',
      subjectToken: token,
    }),
    signal: AbortSignal.timeout(15_000),
    redirect: 'error',
  });
  if (exchanged.ok)
    throw new ProbeFailure(
      'Federation unexpectedly accepted this context; no further cloud request was made',
    );
  const error = await exchanged.json();
  if (
    !['invalid_grant', 'unauthorized_client'].includes(error.error) ||
    !/rejected by the attribute condition/i.test(error.error_description ?? '')
  )
    throw new ProbeFailure(
      `Unexpected STS failure (HTTP ${exchanged.status}); attribute-condition rejection was not verified`,
    );
  console.log(
    'Verified: Google rejected this signed GitHub context by the live attribute condition.',
  );
}

main().catch((error) => {
  console.error(
    error instanceof ProbeFailure
      ? error.message
      : 'Federation probe could not complete; live rejection was not verified',
  );
  process.exitCode = 1;
});
