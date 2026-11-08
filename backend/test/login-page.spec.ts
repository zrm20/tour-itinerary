import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { AppModule } from '../src/app.module';
import { createServer } from 'node:net';
import { get, type IncomingHttpHeaders } from 'node:http';
import { authDatabase } from './fixtures/auth-database';
import {
  authorizationRequest,
  callbackCode,
  exchangeCode,
} from '../scripts/oidc-client.mjs';
import { provisionOidc } from '../scripts/auth-setup.mjs';
import { generateKeyPair, exportJWK } from 'jose';
import { makeSignature, symmetricEncrypt } from 'better-auth/crypto';
import pg from 'pg';

let database: Awaited<ReturnType<typeof authDatabase>>;
let issuer: string;
let app: INestApplication;
const secret = 'test-only-secret-at-least-thirty-two-characters';
const credentials = {
  email: 'browser@example.test',
  password: 'test-password-12345',
};
const options = () => ({
  issuer,
  audience: 'urn:tour-itinerary:api',
  clientId: 'local-cli',
  callback: 'http://127.0.0.1:9876/callback',
});

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
  vi.stubEnv('ACCESS_TOKEN_TTL_SECONDS', '30');
  await provisionOidc(database.migration, {
    audience: 'urn:tour-itinerary:api',
    clientId: 'local-cli',
    callback: 'http://127.0.0.1:9876/callback',
    lifetime: 30,
  });
  const keys = await generateKeyPair('RS256', { extractable: true });
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
            data: JSON.stringify(await exportJWK(keys.privateKey)),
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

  const signup = await fetch(`${issuer}/sign-up/email`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: new URL(issuer).origin,
    },
    body: JSON.stringify({
      ...credentials,
      firstName: 'Browser',
      lastName: 'User',
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!signup.ok) throw new Error('Test account registration failed');
}, 60000);

afterAll(async () => {
  await app?.close();
  await database?.close();
  vi.unstubAllEnvs();
});

/**
 * Perform a top-level browser navigation. Node's fetch always sends
 * `sec-fetch-mode: cors`, so navigation is issued with node:http instead.
 */
async function navigate(url: URL | string) {
  return new Promise<{
    status: number;
    headers: IncomingHttpHeaders;
    body: string;
  }>((resolve, reject) => {
    const request = get(
      url,
      {
        headers: { accept: 'text/html', 'sec-fetch-mode': 'navigate' },
        timeout: 10000,
      },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => (body += chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode!,
            headers: response.headers,
            body,
          }),
        );
      },
    );
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', reject);
  });
}

/** Start authorization as a browser navigation and follow it to the login page. */
async function openLoginPage(request = authorizationRequest(options())) {
  const authorize = await navigate(request.url);
  expect(authorize.status).toBe(302);
  const login = new URL(authorize.headers.location!, issuer);
  return { request, login };
}

/** Submit credentials the way the login page script does. */
async function submit(
  login: URL,
  account: { email: string; password: string },
  oauthQuery = login.search.slice(1),
) {
  return fetch(`${issuer}/sign-in/email`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      origin: new URL(issuer).origin,
      'sec-fetch-mode': 'cors',
    },
    body: JSON.stringify({ ...account, oauth_query: oauthQuery }),
    redirect: 'manual',
    signal: AbortSignal.timeout(10000),
  });
}

async function currentUser(token: string) {
  const response = await fetch(`${new URL(issuer).origin}/graphql`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query: '{ currentUser { id email } }' }),
    signal: AbortSignal.timeout(10000),
  });
  return (await response.json()) as {
    data?: { currentUser?: { id: string; email: string } };
  };
}

/** Re-sign a provider continuation with another expiry using the provider secret. */
async function resignedContinuation(login: URL, offsetSeconds: number) {
  const params = new URLSearchParams(login.search);
  params.delete('sig');
  params.set('exp', String(Math.floor(Date.now() / 1000) + offsetSeconds));
  const canonical = new URLSearchParams(
    [...params.entries()].sort(([a, x], [b, y]) =>
      a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0,
    ),
  );
  params.set('sig', await makeSignature(canonical.toString(), secret));
  return params.toString();
}

function sessionCookie(response: Response) {
  return response.headers
    .getSetCookie()
    .find((value) => value.startsWith('better-auth.session_token='));
}

test('an unauthenticated browser authorization request is redirected to an HTML email/password login page', async () => {
  const { login } = await openLoginPage();
  expect(login.origin).toBe(new URL(issuer).origin);
  expect(login.pathname).toBe('/auth/login');
  expect(login.searchParams.get('sig')).toBeTruthy();

  const page = await navigate(login);
  expect(page.status).toBe(200);
  expect(page.headers['content-type']).toContain('text/html');
  expect(page.headers['cache-control']).toContain('no-store');
  expect(page.headers['referrer-policy']).toBe('no-referrer');
  const policy = page.headers['content-security-policy']!;
  expect(policy).toContain("default-src 'none'");
  expect(policy).toContain("connect-src 'self'");
  expect(policy).toContain("frame-ancestors 'none'");
  expect(policy).not.toContain('unsafe-inline');
  const html = page.body;
  expect(html).toMatch(/<form[^>]*id="login"/);
  expect(html).toMatch(/<input[^>]*type="email"[^>]*name="email"/);
  expect(html).toMatch(/<input[^>]*type="password"[^>]*name="password"/);
  expect(html).not.toContain(login.searchParams.get('sig')!);
});

test('valid credentials resume authorization to the registered callback with the original state, yielding an accepted access token', async () => {
  const { request, login } = await openLoginPage();
  const response = await submit(login, credentials);
  expect(response.status).toBe(200);
  expect(sessionCookie(response)).toBeTruthy();
  const result = (await response.json()) as { redirect: boolean; url: string };
  expect(result.redirect).toBe(true);
  const callback = new URL(result.url);
  expect(`${callback.origin}${callback.pathname}`).toBe(options().callback);
  expect(callback.searchParams.get('state')).toBe(request.state);
  expect(callback.searchParams.get('code')).toBeTruthy();

  const tokens = await exchangeCode(request, callbackCode(result.url, request));
  const user = (await currentUser(tokens.access_token)).data?.currentUser;
  expect(user?.email).toBe(credentials.email);
  expect(user?.id).toMatch(/^[0-9a-f-]{36}$/);
});

test('invalid credentials fail generically without exposing input, and a retry with the same continuation succeeds', async () => {
  const { request, login } = await openLoginPage();
  const wrongPassword = await submit(login, {
    ...credentials,
    password: 'wrong-password-12345',
  });
  const unknownEmail = await submit(login, {
    email: 'nobody@example.test',
    password: 'wrong-password-12345',
  });
  for (const response of [wrongPassword, unknownEmail]) {
    expect(response.status).toBe(401);
    expect(sessionCookie(response)).toBeUndefined();
    const body = await response.text();
    expect(body).not.toContain('wrong-password-12345');
    expect(body).not.toContain('example.test');
    expect(body).not.toContain(options().callback);
  }

  expect((await navigate(login)).body).toContain(
    'Incorrect email or password.',
  );

  const retry = await submit(login, credentials);
  expect(retry.status).toBe(200);
  const result = (await retry.json()) as { url: string };
  expect(callbackCode(result.url, request)).toBeTruthy();
});

test('a login page without a continuation is rejected without a form', async () => {
  const page = await navigate(`${issuer}/login`);
  expect(page.status).toBe(400);
  expect(page.headers['content-type']).toContain('text/html');
  expect(page.headers.location).toBeUndefined();
  expect(page.body).not.toContain('<form');
});

test('tampered and expired continuations are rejected by the page and by sign-in without redirecting', async () => {
  const { login } = await openLoginPage();
  const tampered = new URL(login);
  tampered.searchParams.set('redirect_uri', 'https://attacker.test/callback');
  const resigned = new URL(login);
  resigned.search = await resignedContinuation(login, 60);
  expect((await navigate(resigned)).status).toBe(200);
  const expired = new URL(login);
  expired.search = await resignedContinuation(login, -60);
  const extraParameter = new URL(login);
  extraParameter.searchParams.set('next', 'https://attacker.test/');

  for (const url of [tampered, expired, extraParameter]) {
    const page = await navigate(url);
    expect(page.status).toBe(400);
    expect(page.headers.location).toBeUndefined();
    expect(page.body).not.toContain('<form');
    expect(page.body).not.toContain('attacker.test');

    const response = await submit(url, credentials);
    expect(response.status).toBe(400);
    expect(response.headers.get('location')).toBeNull();
    expect(sessionCookie(response)).toBeUndefined();
    expect(await response.text()).not.toContain('attacker.test');
  }
});

test('an authorization request with an unregistered callback never reaches the login page or the untrusted callback', async () => {
  const request = authorizationRequest(options());
  request.url.searchParams.set(
    'redirect_uri',
    'https://attacker.test/callback',
  );
  const response = await navigate(request.url);
  const location = response.headers.location;
  if (location) {
    const target = new URL(location, issuer);
    expect(target.origin).toBe(new URL(issuer).origin);
    expect(target.pathname).not.toBe('/auth/login');
  }
  expect(response.body).not.toContain('attacker.test');
});
