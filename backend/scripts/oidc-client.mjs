import { URLSearchParams } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { open, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
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

/** End the provider session identified by the ID token via RP-initiated logout. */
export async function signOut(options, { idToken }) {
  const response = await fetch(`${options.issuer}/oauth2/end-session`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: options.clientId,
      id_token_hint: idToken,
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error('OIDC sign-out rejected');
  await response.body?.cancel();
}

class SessionFileError extends Error {}

async function readSession(path, options) {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error.code === 'ENOENT')
      throw new SessionFileError(
        'No saved CLI session. Run auth:signin first.',
      );
    throw error;
  }
  try {
    const info = await file.stat();
    if (
      !info.isFile() ||
      (info.mode & 0o077) !== 0 ||
      (process.getuid && info.uid !== process.getuid())
    )
      throw new SessionFileError(
        'Session file must be private and owned by the current user (mode 0600).',
      );
    const session = JSON.parse(await file.readFile('utf8'));
    if (
      session.issuer !== options.issuer ||
      session.clientId !== options.clientId
    )
      throw new SessionFileError(
        'Saved CLI session does not match AUTH_ISSUER and OIDC_CLIENT_ID.',
      );
    if (typeof session.idToken !== 'string' || !session.idToken)
      throw new SessionFileError('Saved CLI session has no logout handle.');
    return session;
  } finally {
    await file.close();
  }
}

async function main() {
  const mode = process.argv[2] ?? 'signin';
  if (!['signin', 'register', 'signout'].includes(mode))
    throw new Error('Use auth:signin, auth:register, or auth:signout');
  const issuer = process.env.AUTH_ISSUER;
  if (!issuer) throw new Error('AUTH_ISSUER is required');
  const register = mode === 'register';
  if (
    !register &&
    (!process.env.OIDC_CLIENT_ID || !process.env.OIDC_CALLBACK_URL)
  )
    throw new Error('OIDC_CLIENT_ID and OIDC_CALLBACK_URL are required');
  const oidc = {
    issuer,
    audience: process.env.API_AUDIENCE ?? 'urn:tour-itinerary:api',
    clientId: process.env.OIDC_CLIENT_ID,
    callback: process.env.OIDC_CALLBACK_URL,
  };
  if (register) {
    const account = await accountInput(true);
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
  const sessionPath = resolve(
    process.env.OIDC_SESSION_FILE ?? '.oidc-session.json',
  );
  if (mode === 'signout') {
    const session = await readSession(sessionPath, oidc);
    console.log('Ending the saved provider session…');
    await signOut(oidc, { idToken: session.idToken });
    await unlink(sessionPath);
    console.log(
      'Signed out of the current session. Local tokens were discarded; an already-issued access token may remain usable until expiry.',
    );
    return;
  }
  // Reserve the path before authenticating so repeated/concurrent commands
  // cannot replace a live session's logout handle.
  let sessionFile;
  try {
    sessionFile = await open(sessionPath, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'EEXIST')
      throw new SessionFileError(
        'A CLI session file already exists. Run auth:signout first or choose another OIDC_SESSION_FILE.',
      );
    throw error;
  }
  let tokens;
  let saved = false;
  try {
    const account = await accountInput(false);
    console.log('Signing in and loading your profile…');
    tokens = await signIn(oidc, account);
    await sessionFile.writeFile(
      JSON.stringify({
        issuer: oidc.issuer,
        clientId: oidc.clientId,
        idToken: tokens.id_token,
      }),
    );
    saved = true;
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
    console.log(
      'Session saved privately. Run npm run auth:signout with the same OIDC_SESSION_FILE to end it.',
    );
  } finally {
    await sessionFile.close();
    if (!saved) {
      if (tokens) {
        try {
          await signOut(oidc, { idToken: tokens.id_token });
        } catch {
          console.error(
            'Could not end the provider session after failing to save its logout handle.',
          );
        }
      }
      await unlink(sessionPath);
    }
  }
}

if (process.argv[1]?.endsWith('/oidc-client.mjs')) {
  main().catch((error) => {
    // Missing configuration is actionable; provider/network diagnostics stay private.
    const message = error instanceof Error ? error.message : '';
    if (
      error instanceof SessionFileError ||
      message.endsWith(' is required without an interactive terminal') ||
      message === 'AUTH_ISSUER is required' ||
      message === 'OIDC_CLIENT_ID and OIDC_CALLBACK_URL are required' ||
      message === 'Use auth:signin, auth:register, or auth:signout'
    )
      console.error(message);
    else if (error?.name === 'AbortError') console.error('Cancelled.');
    else {
      const action =
        process.argv[2] === 'register'
          ? 'registration'
          : process.argv[2] === 'signout'
            ? 'sign-out'
            : 'sign-in';
      console.error(
        `OIDC ${action} failed; credentials and tokens were not printed. Any saved session was retained for auth:signout.`,
      );
    }
    process.exitCode = 1;
  });
}
