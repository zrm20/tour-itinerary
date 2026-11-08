import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { AppModule } from '../src/app.module';

import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authDatabase } from './fixtures/auth-database';
import {
  authorizationRequest,
  callbackCode,
  exchangeCode,
  signIn,
  signOut,
  type TokenSet,
} from '../scripts/oidc-client.mjs';
import { generateKeyPair, exportJWK, SignJWT, decodeJwt } from 'jose';
import { symmetricEncrypt } from 'better-auth/crypto';
import pg from 'pg';
import { provisionOidc } from '../scripts/auth-setup.mjs';
let database: Awaited<ReturnType<typeof authDatabase>>;
let issuer: string;
let signingKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
let happyTokens: TokenSet;
const secret = 'test-only-secret-at-least-thirty-two-characters';
const credentials = {
  email: 'alex@example.test',
  password: 'test-password-12345',
};
const profileQuery =
  '{ currentUser { id email firstName lastName preferredName displayName } }';
const options = () => ({
  issuer,
  audience: 'urn:tour-itinerary:api',
  clientId: 'local-cli',
  callback: 'http://127.0.0.1:9876/callback',
});
async function post(path: string, body: unknown, cookie?: string) {
  return fetch(`${issuer}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: new URL(issuer).origin,
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
}
async function currentUser(token?: string) {
  const response = await fetch(`${new URL(issuer).origin}/graphql`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ query: profileQuery }),
    signal: AbortSignal.timeout(10000),
  });
  return (await response.json()) as {
    data?: {
      currentUser?: {
        id: string;
        email: string;
        displayName: string;
        preferredName: string | null;
      };
    };
    errors?: { message: string; extensions: { code: string } }[];
  };
}
let app: INestApplication;
beforeAll(async () => {
  database = await authDatabase();
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No port');
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  issuer = `http://127.0.0.1:${port}/auth`;
  vi.stubEnv('DATABASE_URL', database.runtime);
  vi.stubEnv('AUTH_ISSUER', issuer);
  vi.stubEnv('AUTH_SECRET', secret);
  vi.stubEnv('ACCESS_TOKEN_TTL_SECONDS', '2');
  await provisionOidc(database.migration, {
    audience: 'urn:tour-itinerary:api',
    clientId: 'local-cli',
    callback: 'http://127.0.0.1:9876/callback',
    lifetime: 2,
  });
  const keys = await generateKeyPair('RS256', { extractable: true });
  signingKey = keys.privateKey;
  const owner = new pg.Client({ connectionString: database.migration });
  await owner.connect();
  try {
    await owner.query(
      'INSERT INTO auth_jwks (id, "publicKey", "privateKey", "createdAt", alg) VALUES ($1,$2,$3,now(),$4)',
      [
        'test-signing-key',
        JSON.stringify(await exportJWK(keys.publicKey)),
        JSON.stringify(
          await symmetricEncrypt({
            key: secret,
            data: JSON.stringify(await exportJWK(signingKey)),
          }),
        ),
        'RS256',
      ],
    );
  } finally {
    await owner.end();
  }
  const module = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  app = module.createNestApplication();
  await app.listen(port, '127.0.0.1');
}, 60000);
afterAll(async () => {
  await app?.close();
  await database?.close();
  vi.unstubAllEnvs();
});
test('current-user data requires an OAuth access token over HTTP', async () => {
  const response = await fetch(`${await app.getUrl()}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: '{ currentUser { id email displayName } }' }),
  });
  const body = (await response.json()) as {
    data?: { currentUser?: unknown };
    errors: { extensions: { code: string } }[];
  };
  expect(body.data?.currentUser).toBeFalsy();
  expect(body.errors[0]!.extensions.code).toBe('UNAUTHENTICATED');
});

test('registration issues a real OIDC access token that reads the persisted application profile', async () => {
  const response = await fetch(`${issuer}/sign-up/email`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: new URL(issuer).origin,
    },
    body: JSON.stringify({
      email: 'alex@example.test',
      password: 'test-password-12345',
      name: 'Alex',
      firstName: 'Alex',
      lastName: 'Jones',
    }),
  });
  expect(response.status, await response.clone().text()).toBe(200);
  const tokens = (happyTokens = await signIn(
    {
      issuer,
      audience: 'urn:tour-itinerary:api',
      clientId: 'local-cli',
      callback: 'http://127.0.0.1:9876/callback',
    },
    { email: 'alex@example.test', password: 'test-password-12345' },
  ));
  const profile = await fetch(`${await app.getUrl()}/graphql`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${tokens.access_token}`,
    },
    body: JSON.stringify({
      query:
        '{ currentUser { id email firstName lastName preferredName displayName } }',
    }),
  });
  expect(await profile.json()).toMatchObject({
    data: {
      currentUser: {
        email: 'alex@example.test',
        firstName: 'Alex',
        lastName: 'Jones',
        preferredName: null,
        displayName: 'Alex',
      },
    },
  });
});

test('repeat sign-in preserves the permanent user ID and access-token lifetime is configured in seconds', async () => {
  const first = (await currentUser(happyTokens.access_token)).data!
    .currentUser!;
  const tokens = await signIn(options(), credentials);
  const next = (await currentUser(tokens.access_token)).data!.currentUser!;
  expect(next.id).toBe(first.id);
  expect(next.id).toMatch(/^[0-9a-f-]{36}$/);
  expect(tokens.expires_in).toBe(2);
  const claims = decodeJwt(tokens.access_token);
  expect(claims.exp! - claims.iat!).toBe(2);
  expect(tokens.refresh_token).toBeUndefined();
});

test('preferred name wins over first name and separate registrations receive separate application IDs', async () => {
  const signup = await post('/sign-up/email', {
    email: 'sam@example.test',
    password: credentials.password,
    name: 'Compatibility',
    firstName: 'Samuel',
    lastName: 'Smith',
    preferredName: 'Sam',
  });
  expect(signup.status).toBe(200);
  const tokens = await signIn(options(), {
    email: 'sam@example.test',
    password: credentials.password,
  });
  const profile = (await currentUser(tokens.access_token)).data!.currentUser!;
  expect(profile.displayName).toBe('Sam');
  expect(profile.preferredName).toBe('Sam');
  expect(profile.id).not.toBe(
    (await currentUser((await signIn(options(), credentials)).access_token))
      .data!.currentUser!.id,
  );
});

test.each(['email', 'password', 'firstName', 'lastName'])(
  'registration requires %s',
  async (field) => {
    const body: Record<string, string> = {
      email: `missing-${field}@example.test`,
      password: credentials.password,
      name: 'Required',
      firstName: 'Required',
      lastName: 'Fields',
    };
    delete body[field];
    const response = await post('/sign-up/email', body);
    expect(response.ok).toBe(false);
  },
);

test.each(['firstName', 'lastName', 'preferredName'])(
  'registration rejects blank %s',
  async (field) => {
    const response = await post('/sign-up/email', {
      email: `blank-${field}@example.test`,
      password: credentials.password,
      name: 'Blank',
      firstName: 'Alex',
      lastName: 'Jones',
      [field]: '  ',
    });
    expect(response.ok).toBe(false);
  },
);

test('duplicate unverified email cannot replace an identity or password', async () => {
  const before = (
    await currentUser((await signIn(options(), credentials)).access_token)
  ).data!.currentUser!;
  const response = await post('/sign-up/email', {
    ...credentials,
    password: 'attacker-password-1234',
    name: 'Attacker',
    firstName: 'Attacker',
    lastName: 'Account',
  });
  expect(response.ok).toBe(false);
  await expect(
    signIn(options(), { ...credentials, password: 'attacker-password-1234' }),
  ).rejects.toThrow('sign-in rejected');
  expect(
    (await currentUser((await signIn(options(), credentials)).access_token))
      .data!.currentUser!.id,
  ).toBe(before.id);
});

test('dynamic registration and authenticated client-management endpoints are not enabled', async () => {
  const response = await post('/oauth2/register', {
    client_name: 'Untrusted',
    redirect_uris: ['https://attacker.test/callback'],
  });
  expect(response.ok).toBe(false);
});

async function signedNegativeToken(
  overrides: Record<string, unknown> = {},
  typ = 'at+jwt',
) {
  const claims = decodeJwt((await signIn(options(), credentials)).access_token);
  return new SignJWT({ ...claims, ...overrides })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-signing-key', typ })
    .sign(signingKey);
}

test.each([
  ['issuer', { iss: 'https://attacker.test/auth' }],
  ['audience', { aud: 'urn:other-api' }],
  ['expiry', { exp: 1 }],
  ['missing expiry', { exp: undefined }],
  ['unmapped subject', { sub: 'unmapped-provider-user' }],
])(
  'API rejects a correctly signed access token with invalid %s',
  async (_name, claims) => {
    const result = await currentUser(await signedNegativeToken(claims));
    expect(result.data?.currentUser).toBeFalsy();
    expect(result.errors?.[0]?.extensions.code).toBe('UNAUTHENTICATED');
  },
);

test('API rejects ID tokens, session tokens, malformed tokens, bad signatures and wrong token kinds', async () => {
  const tokens = await signIn(options(), credentials);
  const session = await post('/sign-in/email', credentials);
  const sessionBody = (await session.json()) as { token: string };
  const altered = tokens.access_token.split('.');
  altered[2] = 'a'.repeat(altered[2]!.length);
  for (const token of [
    tokens.id_token,
    sessionBody.token,
    'invalid',
    altered.join('.'),
    await signedNegativeToken({}, 'JWT'),
  ]) {
    const result = await currentUser(token);
    expect(result.data?.currentUser).toBeFalsy();
    expect(result.errors?.[0]?.extensions.code).toBe('UNAUTHENTICATED');
  }
});

test('a real issued access token stops working after its short configured expiry', async () => {
  const token = (await signIn(options(), credentials)).access_token;
  expect((await currentUser(token)).data?.currentUser).toBeTruthy();
  await new Promise((resolve) => setTimeout(resolve, 2100));
  expect((await currentUser(token)).errors?.[0]?.extensions.code).toBe(
    'UNAUTHENTICATED',
  );
});

async function authorizationCode() {
  const request = authorizationRequest(options());
  const response = await fetch(request.url, { redirect: 'manual' });
  const redirect = (await response.json()) as { url: string };
  const login = new URL(redirect.url, issuer);
  const signedIn = await post('/sign-in/email', {
    ...credentials,
    oauth_query: login.search.slice(1),
  });
  const result = (await signedIn.json()) as { url: string };
  return {
    request,
    code: callbackCode(result.url, request),
    location: result.url,
    signedQuery: login.search.slice(1),
  };
}

test('the authorization code is bound to S256 PKCE and cannot be reused', async () => {
  const first = await authorizationCode();
  await expect(
    exchangeCode(first.request, first.code, 'x'.repeat(43)),
  ).rejects.toThrow('exchange rejected');
  const second = await authorizationCode();
  await exchangeCode(second.request, second.code);
  await expect(exchangeCode(second.request, second.code)).rejects.toThrow(
    'exchange rejected',
  );
});

test('callback and state mismatches are rejected by the local client', async () => {
  const { request, location } = await authorizationCode();
  const badState = new URL(location);
  badState.searchParams.set('state', 'wrong-state');
  expect(() => callbackCode(badState.href, request)).toThrow(
    'callback/state mismatch',
  );
  const badCallback = new URL(location);
  badCallback.hostname = 'attacker.test';
  expect(() => callbackCode(badCallback.href, request)).toThrow(
    'callback/state mismatch',
  );
});

test('unregistered callbacks, missing PKCE and tampered signed login continuations are rejected', async () => {
  const request = authorizationRequest(options());
  request.url.searchParams.set(
    'redirect_uri',
    'https://attacker.test/callback',
  );
  const rejected = await fetch(request.url, { redirect: 'manual' });
  expect(rejected.headers.get('location')).toBeNull();
  const errorBody = await rejected.text();
  expect(errorBody).not.toContain('https://attacker.test/callback');
  expect(errorBody).not.toContain('/auth/login?');
  const missingPkce = authorizationRequest(options());
  missingPkce.url.searchParams.delete('code_challenge');
  const response = await fetch(missingPkce.url, { redirect: 'manual' });
  expect(await response.text()).not.toContain('/auth/login?');
  const flow = await authorizationCode();
  const tampered = await post('/sign-in/email', {
    ...credentials,
    oauth_query: flow.signedQuery.replace('local-cli', 'other-client'),
  });
  expect(tampered.ok).toBe(false);
});

test('application identity is not linked by an existing application email', async () => {
  const owner = new pg.Client({ connectionString: database.migration });
  await owner.connect();
  try {
    await owner.query(
      'INSERT INTO application_user (id, email, "firstName", "lastName") VALUES ($1,$2,$3,$4)',
      [
        'existing-independent-user',
        'same-email@example.test',
        'Independent',
        'Identity',
      ],
    );
  } finally {
    await owner.end();
  }
  expect(
    (
      await post('/sign-up/email', {
        email: 'same-email@example.test',
        password: credentials.password,
        firstName: 'New',
        lastName: 'Person',
      })
    ).status,
  ).toBe(200);
  const token = (
    await signIn(options(), {
      email: 'same-email@example.test',
      password: credentials.password,
    })
  ).access_token;
  const profile = (await currentUser(token)).data!.currentUser!;
  expect(profile.id).not.toBe('existing-independent-user');
  expect(profile.displayName).toBe('New');
});

test('a provisioning failure can be retried at sign-in without linking by email or duplicating users', async () => {
  const owner = new pg.Client({ connectionString: database.migration });
  await owner.connect();
  try {
    await owner.query('REVOKE INSERT ON provider_identity FROM it_runtime');
    const response = await post('/sign-up/email', {
      email: 'retry@example.test',
      password: credentials.password,
      firstName: 'Retry',
      lastName: 'Person',
    });
    expect(response.ok).toBe(false);
    expect(await response.text()).not.toMatch(
      /Prisma|postgres|it_runtime|password|provider_identity/,
    );
  } finally {
    await owner.query('GRANT INSERT ON provider_identity TO it_runtime');
    await owner.end();
  }
  const tokens = await signIn(options(), {
    email: 'retry@example.test',
    password: credentials.password,
  });
  const first = (await currentUser(tokens.access_token)).data!.currentUser!;
  const again = await Promise.all([
    signIn(options(), {
      email: 'retry@example.test',
      password: credentials.password,
    }),
    signIn(options(), {
      email: 'retry@example.test',
      password: credentials.password,
    }),
  ]);
  for (const token of again)
    expect((await currentUser(token.access_token)).data!.currentUser!.id).toBe(
      first.id,
    );
});

test('database failures are bounded and sanitized while health stays independent, then authentication recovers', async () => {
  await database.admin.query(
    `REVOKE CONNECT ON DATABASE ${database.name} FROM it_runtime`,
  );
  await database.admin.query(
    'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND usename = $2',
    [database.name, 'it_runtime'],
  );
  try {
    const start = performance.now();
    const response = await post('/sign-in/email', credentials);
    expect(response.ok).toBe(false);
    expect(await response.text()).not.toMatch(
      /Prisma|postgres|it_runtime|local-runtime|SELECT|password/,
    );
    expect(performance.now() - start).toBeLessThan(10000);
    const health = await fetch(`${new URL(issuer).origin}/health`);
    expect(health.status).toBe(200);
  } finally {
    await database.admin.query(
      `GRANT CONNECT ON DATABASE ${database.name} TO it_runtime`,
    );
  }
  expect(
    (await currentUser((await signIn(options(), credentials)).access_token))
      .data?.currentUser,
  ).toBeTruthy();
});

test('OIDC discovery publishes the configured issuer and real protocol endpoints', async () => {
  const response = await fetch(`${issuer}/.well-known/openid-configuration`);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    issuer,
    authorization_endpoint: `${issuer}/oauth2/authorize`,
    token_endpoint: `${issuer}/oauth2/token`,
    jwks_uri: `${issuer}/jwks`,
    end_session_endpoint: `${issuer}/oauth2/end-session`,
    code_challenge_methods_supported: ['S256'],
  });
});

/** Complete OIDC sign-in while retaining the provider session cookie. */
async function signInWithSession() {
  const request = authorizationRequest(options());
  const authorize = await fetch(request.url, {
    redirect: 'manual',
    headers: { accept: 'text/html' },
    signal: AbortSignal.timeout(10000),
  });
  const login =
    authorize.headers.get('location') ??
    (authorize.ok
      ? ((await authorize.json()) as { url: string }).url
      : undefined);
  if (typeof login !== 'string') throw new Error('missing login redirect');
  const loginUrl = new URL(login, issuer);
  const signedIn = await post('/sign-in/email', {
    ...credentials,
    oauth_query: loginUrl.search.slice(1),
  });
  expect(signedIn.ok).toBe(true);
  const cookie = signedIn.headers
    .getSetCookie()
    .find((value) => value.startsWith('better-auth.session_token='));
  expect(cookie).toBeTruthy();
  const result = (await signedIn.json()) as { url: string };
  const tokens = await exchangeCode(request, callbackCode(result.url, request));
  return {
    tokens,
    cookie: cookie!.split(';', 1)[0]!,
  };
}

async function authorizeWithSession(cookie: string) {
  const request = authorizationRequest(options());
  const response = await fetch(request.url, {
    redirect: 'manual',
    headers: { accept: 'application/json', cookie },
    signal: AbortSignal.timeout(10000),
  });
  return { request, response };
}

async function runCli(
  mode: string,
  sessionFile: string,
  account: Record<string, string> = {},
) {
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (key.startsWith('OIDC_')) delete env[key];
  const child = spawn(process.execPath, ['scripts/oidc-client.mjs', mode], {
    env: {
      ...env,
      AUTH_ISSUER: issuer,
      OIDC_CLIENT_ID: options().clientId,
      OIDC_CALLBACK_URL: options().callback,
      OIDC_SESSION_FILE: sessionFile,
      ...account,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.end();
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  return { code, output };
}

test('CLI sign-out ends the saved session without credentials or a new sign-in, preserving another session', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'oidc-cli-'));
  const sessionFile = join(directory, 'session.json');
  try {
    const first = await signInWithSession();
    const second = await signInWithSession();
    await writeFile(
      sessionFile,
      JSON.stringify({
        issuer,
        clientId: options().clientId,
        idToken: first.tokens.id_token,
      }),
      { mode: 0o600 },
    );
    const result = await runCli('signout', sessionFile);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('Signed out of the current session');
    expect(result.output).not.toContain(first.tokens.id_token);
    await expect(stat(sessionFile)).rejects.toMatchObject({ code: 'ENOENT' });

    const ended = await authorizeWithSession(first.cookie);
    const location =
      ended.response.headers.get('location') ??
      ((await ended.response.json()) as { url: string }).url;
    expect(new URL(location, issuer).pathname).toBe('/auth/login');
    const surviving = await authorizeWithSession(second.cookie);
    const body = (await surviving.response.json()) as { url: string };
    const tokens = await exchangeCode(
      surviving.request,
      callbackCode(body.url, surviving.request),
    );
    expect(
      (await currentUser(tokens.access_token)).data?.currentUser,
    ).toBeTruthy();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('CLI sign-in saves only a private logout handle and refuses to overwrite a live session', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'oidc-cli-'));
  const sessionFile = join(directory, 'session.json');
  try {
    const result = await runCli('signin', sessionFile, {
      OIDC_EMAIL: credentials.email,
      OIDC_PASSWORD: credentials.password,
    });
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain(credentials.email);
    const saved = JSON.parse(await readFile(sessionFile, 'utf8')) as {
      issuer: string;
      clientId: string;
      idToken: string;
    };
    expect(Object.keys(saved).sort()).toEqual([
      'clientId',
      'idToken',
      'issuer',
    ]);
    expect(saved.issuer).toBe(issuer);
    expect(saved.clientId).toBe(options().clientId);
    expect(decodeJwt(saved.idToken)).toMatchObject({
      iss: issuer,
      aud: options().clientId,
    });
    expect((await stat(sessionFile)).mode & 0o777).toBe(0o600);
    expect(result.output).not.toContain(saved.idToken);
    expect(result.output).not.toContain(credentials.password);
    const repeated = await runCli('signin', sessionFile);
    expect(repeated.code).toBe(1);
    expect(repeated.output).toContain('Run auth:signout first');
    expect(await readFile(sessionFile, 'utf8')).toBe(JSON.stringify(saved));
    const logout = await runCli('signout', sessionFile);
    expect(logout.code, logout.output).toBe(0);
    await expect(stat(sessionFile)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('current-session sign-out ends that provider session without ending another, while an issued JWT remains usable until expiry', async () => {
  const first = await signInWithSession();
  const second = await signInWithSession();
  expect(
    (await currentUser(first.tokens.access_token)).data?.currentUser,
  ).toBeTruthy();
  expect(
    (await currentUser(second.tokens.access_token)).data?.currentUser,
  ).toBeTruthy();

  await signOut(options(), { idToken: first.tokens.id_token });

  const ended = await authorizeWithSession(first.cookie);
  expect(ended.response.ok || ended.response.status === 302).toBe(true);
  const endedBody = ended.response.headers.get('location')
    ? ended.response.headers.get('location')!
    : ((await ended.response.json()) as { url?: string }).url;
  expect(endedBody).toBeTruthy();
  expect(new URL(endedBody!, issuer).pathname).toBe('/auth/login');

  const surviving = await authorizeWithSession(second.cookie);
  expect(surviving.response.ok).toBe(true);
  const survivingBody = (await surviving.response.json()) as { url: string };
  const renewed = await exchangeCode(
    surviving.request,
    callbackCode(survivingBody.url, surviving.request),
  );
  expect(
    (await currentUser(renewed.access_token)).data?.currentUser,
  ).toBeTruthy();
  expect(renewed.refresh_token).toBeUndefined();

  expect(
    (await currentUser(first.tokens.access_token)).data?.currentUser,
  ).toBeTruthy();
  expect(
    (await currentUser(renewed.access_token)).data?.currentUser,
  ).toBeTruthy();
  await new Promise((resolve) => setTimeout(resolve, 2100));
  expect(
    (await currentUser(first.tokens.access_token)).errors?.[0]?.extensions.code,
  ).toBe('UNAUTHENTICATED');
  const stillAlive = await authorizeWithSession(second.cookie);
  expect(stillAlive.response.ok).toBe(true);
  const stillBody = (await stillAlive.response.json()) as { url: string };
  const afterExpiry = await exchangeCode(
    stillAlive.request,
    callbackCode(stillBody.url, stillAlive.request),
  );
  expect(
    (await currentUser(afterExpiry.access_token)).data?.currentUser,
  ).toBeTruthy();
});
