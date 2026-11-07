import { URLSearchParams } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { accountInput } from './auth-prompts.mjs';

export function authorizationRequest({ issuer, audience, clientId, callback }) {
  const verifier = randomBytes(32).toString('base64url');
  const state = randomBytes(32).toString('base64url');
  const nonce = randomBytes(32).toString('base64url');
  const url = new URL(`${issuer}/oauth2/authorize`);
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: callback,
    response_type: 'code',
    scope: 'openid profile email',
    resource: audience,
    state,
    nonce,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
  }).toString();
  return { url, verifier, state, nonce, issuer, audience, clientId, callback };
}

export function callbackCode(location, request) {
  const url = new URL(location);
  const expected = new URL(request.callback);
  if (
    url.origin !== expected.origin ||
    url.pathname !== expected.pathname ||
    url.searchParams.get('state') !== request.state ||
    (url.searchParams.has('iss') &&
      url.searchParams.get('iss') !== request.issuer)
  )
    throw new Error('OIDC callback/state mismatch');
  if (url.searchParams.has('error') || !url.searchParams.get('code'))
    throw new Error('OIDC authorization was rejected');
  return url.searchParams.get('code');
}

export async function exchangeCode(request, code, verifier = request.verifier) {
  const response = await fetch(`${request.issuer}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: request.clientId,
      redirect_uri: request.callback,
      resource: request.audience,
      code,
      code_verifier: verifier,
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error('OIDC code exchange rejected');
  const tokens = await response.json();
  // The CLI is also an OIDC client: validate its ID token, nonce, issuer and
  // audience independently. The API receives only the OAuth access token.
  const { createRemoteJWKSet, jwtVerify } = await import('jose');
  const { payload } = await jwtVerify(
    tokens.id_token,
    createRemoteJWKSet(new URL(`${request.issuer}/jwks`)),
    {
      issuer: request.issuer,
      audience: request.clientId,
      algorithms: ['RS256'],
      requiredClaims: ['sub', 'exp', 'iat', 'nonce'],
    },
  );
  if (payload.nonce !== request.nonce) throw new Error('OIDC nonce mismatch');
  return tokens;
}

export async function signIn(options, { email, password }) {
  const request = authorizationRequest(options);
  const response = await fetch(request.url, {
    redirect: 'manual',
    headers: { accept: 'text/html' },
    signal: AbortSignal.timeout(10000),
  });
  const login =
    response.headers.get('location') ??
    (response.ok ? (await response.json()).url : undefined);
  if (typeof login !== 'string')
    throw new Error('OIDC authorization did not redirect to sign-in');
  const loginUrl = new URL(login, options.issuer);
  if (
    loginUrl.origin !== new URL(options.issuer).origin ||
    loginUrl.pathname !== '/auth/login'
  )
    throw new Error('Untrusted OIDC login redirect');
  const signedQuery = loginUrl.search.slice(1);
  const signedIn = await fetch(`${options.issuer}/sign-in/email`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: new URL(options.issuer).origin,
    },
    body: JSON.stringify({ email, password, oauth_query: signedQuery }),
    redirect: 'manual',
    signal: AbortSignal.timeout(10000),
  });
  if (!signedIn.ok) throw new Error('OIDC sign-in rejected');
  const result = await signedIn.json();
  const code = callbackCode(result.url, request);
  return exchangeCode(request, code);
}

async function main() {
  const mode = process.argv[2] ?? 'signin';
  if (!['signin', 'register'].includes(mode))
    throw new Error('Use auth:signin or auth:register');
  const issuer = process.env.AUTH_ISSUER;
  if (!issuer) throw new Error('AUTH_ISSUER is required');
  const register = mode === 'register';
  if (
    !register &&
    (!process.env.OIDC_CLIENT_ID || !process.env.OIDC_CALLBACK_URL)
  )
    throw new Error('OIDC_CLIENT_ID and OIDC_CALLBACK_URL are required');
  const account = await accountInput(register);
  if (register) {
    console.log('Registering account…');
    const response = await fetch(`${issuer}/sign-up/email`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: new URL(issuer).origin,
      },
      body: JSON.stringify(account),
      signal: AbortSignal.timeout(10000),
    });
    // Signup may return a private session token. Never print the response body.
    await response.body?.cancel();
    if (!response.ok) {
      console.error(`Registration rejected (HTTP ${response.status}).`);
      process.exitCode = 1;
      return;
    }
    console.log(
      'Registration succeeded. Run npm run auth:signin to read your profile.',
    );
    return;
  }
  console.log('Signing in and loading your profile…');
  const tokens = await signIn(
    {
      issuer,
      audience: process.env.API_AUDIENCE ?? 'urn:tour-itinerary:api',
      clientId: process.env.OIDC_CLIENT_ID,
      callback: process.env.OIDC_CALLBACK_URL,
    },
    account,
  );
  const response = await fetch(`${new URL(issuer).origin}/graphql`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${tokens.access_token}`,
    },
    body: JSON.stringify({
      query:
        '{ currentUser { id email firstName lastName preferredName displayName } }',
    }),
    signal: AbortSignal.timeout(10000),
  });
  const result = await response.json();
  if (!response.ok || result.errors)
    throw new Error('Current-user request failed');
  console.log(JSON.stringify(result.data.currentUser, null, 2));
}

if (process.argv[1]?.endsWith('/oidc-client.mjs')) {
  main().catch((error) => {
    // Missing configuration is actionable; provider/network diagnostics stay private.
    const message = error instanceof Error ? error.message : '';
    if (
      message.endsWith(' is required without an interactive terminal') ||
      message === 'AUTH_ISSUER is required' ||
      message === 'OIDC_CLIENT_ID and OIDC_CALLBACK_URL are required' ||
      message === 'Use auth:signin or auth:register'
    )
      console.error(message);
    else if (error?.name === 'AbortError') console.error('Cancelled.');
    else
      console.error(
        `OIDC ${process.argv[2] === 'register' ? 'registration' : 'sign-in'} failed; tokens and credentials were not saved`,
      );
    process.exitCode = 1;
  });
}
