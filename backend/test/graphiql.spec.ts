import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { createServer } from 'node:net';
import { get } from 'node:http';
import { createContext, runInContext } from 'node:vm';
import { webcrypto } from 'node:crypto';
import { AppModule } from '../src/app.module';
import { authDatabase } from './fixtures/auth-database';
import { provisionOidc } from '../scripts/auth-setup.mjs';
import { signIn as cliSignIn } from '../scripts/oidc-client.mjs';

let database: Awaited<ReturnType<typeof authDatabase>>;
let app: INestApplication;
let origin: string;
const secret = 'test-only-secret-at-least-thirty-two-characters';
const credentials = {
  email: 'editor@example.test',
  password: 'test-password-12345',
};
const second = {
  email: 'second@example.test',
  password: 'test-password-12345',
};
const query = { query: '{ currentUser { id email } }' };
type Result = {
  data?: { currentUser?: { id: string; email: string } };
  errors?: { extensions: { code: string } }[];
};

beforeAll(async () => {
  database = await authDatabase();
  const socket = createServer();
  await new Promise<void>((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const address = socket.address();
  if (!address || typeof address === 'string') throw new Error('No port');
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  origin = `http://127.0.0.1:${address.port}`;
  vi.stubEnv('DATABASE_URL', database.runtime);
  vi.stubEnv('AUTH_ISSUER', `${origin}/auth`);
  vi.stubEnv('AUTH_SECRET', secret);
  vi.stubEnv('GRAPHQL_PLAYGROUND', 'true');
  vi.stubEnv('GRAPHQL_OIDC_CLIENT_ID', 'graphiql');
  vi.stubEnv('ACCESS_TOKEN_TTL_SECONDS', '30');
  await provisionOidc(database.migration, {
    audience: 'urn:tour-itinerary:api',
    clientId: 'cli',
    callback: 'http://127.0.0.1:9876/callback',
    secret,
    browser: {
      clientId: 'graphiql',
      callback: `${origin}/graphql/auth/callback`,
    },
  });
  const module = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  app = module.createNestApplication();
  await app.listen(address.port, '127.0.0.1');
  for (const account of [credentials, second]) {
    const signup = await fetch(`${origin}/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({
        ...account,
        firstName: 'Editor',
        lastName: 'Tester',
      }),
    });
    expect(signup.ok).toBe(true);
  }
}, 60000);

afterAll(async () => {
  await app?.close();
  await database?.close();
  vi.unstubAllEnvs();
});

// Browser adapters run the inline scripts from the HTTP page verbatim. Only DOM,
// navigation, storage and clocks are adapted; requests reach the actual app/IdP.
async function editor(
  url = `${origin}/graphql`,
  storage = new Map<string, string>(),
) {
  const response = await fetch(url, { headers: { accept: 'text/html' } });
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const html = await response.text();
  const elements = Object.fromEntries(
    ['auth-status', 'sign-in', 'sign-out', 'graphiql'].map((id) => [
      id,
      {
        textContent: '',
        hidden: false,
        disabled: false,
        onclick: async () => {},
      },
    ]),
  );
  let target: string | undefined;
  let now = Date.now();
  let fetcher: (parameters: unknown) => Promise<Result>;
  let settings: Record<string, unknown>;
  const requests: { path: string; init?: RequestInit }[] = [];
  let failure: string | undefined;
  const pageUrl = new URL(url);
  const location = {
    pathname: pageUrl.pathname,
    search: pageUrl.search,
    origin,
    assign: (value: string) => {
      target = value;
    },
  };
  const context = createContext({
    document: { getElementById: (id: string) => elements[id] },
    location,
    history: {
      replaceState: (_state: unknown, _title: string, path: string) => {
        const next = new URL(path, origin);
        location.pathname = next.pathname;
        location.search = next.search;
      },
    },
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
    fetch: async (path: string, init?: RequestInit) => {
      requests.push({ path, init });
      if (path === failure) throw new Error('Simulated network failure');
      return fetch(new URL(path, origin), {
        ...init,
        headers: { ...init?.headers, origin },
      });
    },
    crypto: webcrypto,
    Uint8Array,
    TextEncoder,
    URL,
    URLSearchParams,
    AbortSignal,
    btoa,
    Date: { now: () => now },
    setTimeout: () => 1,
    clearTimeout: () => {},
    React: {
      createElement: (_component: unknown, props: Record<string, unknown>) =>
        props,
    },
    ReactDOM: {
      render: (props: Record<string, unknown>) => {
        settings = props;
        fetcher = props.fetcher as typeof fetcher;
      },
    },
    GraphiQL: {},
  });
  for (const match of html.matchAll(
    /<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g,
  )) {
    if (match[1])
      await (runInContext(match[1], context) as Promise<void> | undefined);
  }
  return {
    storage,
    elements,
    requests,
    location,
    get target() {
      return target;
    },
    get settings() {
      return settings!;
    },
    get status() {
      return elements['auth-status']!.textContent;
    },
    signin: () => elements['sign-in']!.onclick(),
    signout: () => elements['sign-out']!.onclick(),
    query: (parameters = query) => fetcher(parameters),
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
    fail: (path: string) => {
      failure = path;
    },
  };
}

async function navigate(url: string) {
  return new Promise<string>((resolve, reject) => {
    const request = get(
      url,
      { headers: { accept: 'text/html', 'sec-fetch-mode': 'navigate' } },
      (response) => {
        response.resume();
        response.on('end', () =>
          resolve(new URL(response.headers.location!, origin).href),
        );
      },
    );
    request.on('error', reject);
  });
}

async function authorization(
  page: Awaited<ReturnType<typeof editor>>,
  account = credentials,
) {
  await page.signin();
  const url = new URL(page.target!);
  expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  expect(url.searchParams.get('resource')).toBe('urn:tour-itinerary:api');
  const login = new URL(await navigate(url.href));
  expect(login.pathname).toBe('/auth/login');
  const body = { ...account, oauth_query: login.search.slice(1) };
  const headers = { 'content-type': 'application/json', origin };
  const incorrect = await fetch(`${origin}/auth/sign-in/email`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ ...body, password: 'incorrect' }),
  });
  expect(incorrect.status).toBe(401);
  const signedIn = await fetch(`${origin}/auth/sign-in/email`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  expect(signedIn.ok).toBe(true);
  const cookie = signedIn.headers
    .getSetCookie()
    .find((value) => value.startsWith('better-auth.session_token='))!
    .split(';')[0]!;
  const result = (await signedIn.json()) as { url: string };
  return { callback: result.url, cookie };
}

async function login(account = credentials) {
  const initial = await editor();
  const auth = await authorization(initial, account);
  return { page: await editor(auth.callback, initial.storage), ...auth };
}

async function providerSession(cookie: string) {
  const response = await fetch(`${origin}/auth/get-session`, {
    headers: { cookie },
  });
  return response.json();
}

test('editor signs in through the real login page with PKCE and sends only an access token to currentUser', async () => {
  const { page } = await login();
  expect(page.location).toMatchObject({ pathname: '/graphql', search: '' });
  expect(page.status).toBe('Signed in.');
  const result = await page.query();
  expect(result.data?.currentUser?.email).toBe(credentials.email);
  expect(page.settings).toMatchObject({
    shouldPersistHeaders: false,
    isHeadersEditorEnabled: false,
  });
  const bearer = new Headers(
    page.requests.find((request) => request.path === '/graphql')!.init!.headers,
  ).get('authorization');
  const exchange = page.requests.find((request) =>
    request.path.endsWith('/exchange'),
  )!;
  expect(exchange.init!.method).toBe('POST');
  expect(bearer).toMatch(/^Bearer /);
  const saved = JSON.parse([...page.storage.values()][0]!) as {
    accessToken: string;
    idToken: string;
  };
  expect(bearer).toBe(`Bearer ${saved.accessToken}`);
  expect(bearer).not.toContain(saved.idToken);
  const reloaded = await editor(undefined, page.storage);
  expect((await reloaded.query()).data?.currentUser?.id).toBe(
    result.data?.currentUser?.id,
  );
  expect(
    (await reloaded.query({ query: '{ tour(id: "unknown") { id } }' }))
      .errors?.[0]?.extensions.code,
  ).toBe('FORBIDDEN');
  expect(reloaded.status).toBe('Signed in.');
});

test('logout clears the bearer before the request, ends only this provider session, and switching accounts changes currentUser', async () => {
  const { page, cookie } = await login();
  const other = await login();
  const oldToken = (
    JSON.parse([...page.storage.values()][0]!) as { accessToken: string }
  ).accessToken;
  expect(await providerSession(cookie)).not.toBeNull();
  await page.signout();
  expect(page.status).toContain('Signed out.');
  expect([...page.storage.values()].join('')).not.toContain(oldToken);
  expect((await page.query()).errors?.[0]?.extensions.code).toBe(
    'UNAUTHENTICATED',
  );
  expect(
    new Headers(page.requests.at(-1)!.init!.headers).has('authorization'),
  ).toBe(false);
  expect(await providerSession(cookie)).toBeNull();
  expect(await providerSession(other.cookie)).not.toBeNull();
  const stillValid = await fetch(`${origin}/graphql`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${oldToken}`,
    },
    body: JSON.stringify(query),
  });
  expect(((await stillValid.json()) as Result).data?.currentUser?.email).toBe(
    credentials.email,
  );
  const next = await authorization(page, second);
  const switched = await editor(next.callback, page.storage);
  expect((await switched.query()).data?.currentUser?.email).toBe(second.email);
});

test('expiry stops attaching tokens and public operations remain usable; failed logout retains only a retry handle', async () => {
  const { page } = await login();
  page.advance(31000);
  expect(await page.query({ query: '{ __typename }' })).toMatchObject({
    data: { __typename: 'Query' },
  });
  expect(page.status).toContain('expired');
  expect(
    new Headers(page.requests.at(-1)!.init!.headers).has('authorization'),
  ).toBe(false);
  page.fail('/graphql/auth/logout');
  await page.signout();
  expect(page.status).toContain('Provider sign-out failed');
  const saved = JSON.parse([...page.storage.values()][0]!) as Record<
    string,
    unknown
  >;
  expect(saved.idToken).toBeTruthy();
  expect(saved.accessToken).toBeUndefined();
  expect(page.elements['sign-in']!.hidden).toBe(true);
  const reload = await editor(undefined, page.storage);
  await reload.signout();
  expect(reload.status).toContain('Signed out.');
});

test.each([
  'state',
  'issuer',
  'cancelled',
  'missing-code',
  'duplicate',
  'expired',
  'verifier',
  'nonce',
  'exchange',
])(
  'callback failure (%s) is sanitized, removes response parameters and allows another sign-in',
  async (failure) => {
    const initial = await editor();
    const auth = await authorization(initial);
    const callback = new URL(auth.callback);
    const key = [...initial.storage.keys()][0]!;
    const saved = JSON.parse(initial.storage.get(key)!) as {
      pending: { createdAt: number; verifier: string; nonce: string };
    };
    if (failure === 'state') callback.searchParams.set('state', 'bad-state');
    if (failure === 'issuer')
      callback.searchParams.set('iss', 'https://attacker.test/auth');
    if (failure === 'cancelled')
      callback.searchParams.set('error', 'access_denied');
    if (failure === 'missing-code') callback.searchParams.delete('code');
    if (failure === 'duplicate')
      callback.searchParams.append('code', 'another-code');
    if (failure === 'expired') saved.pending.createdAt -= 600001;
    if (failure === 'verifier') saved.pending.verifier = 'x'.repeat(43);
    if (failure === 'nonce') saved.pending.nonce = 'x'.repeat(43);
    if (failure === 'exchange')
      callback.searchParams.set('code', 'invalid-code');
    initial.storage.set(key, JSON.stringify(saved));
    const page = await editor(callback.href, initial.storage);
    expect(page.location.search).toBe('');
    expect(page.status).toContain('Sign-in failed');
    expect(page.status).not.toContain('invalid-code');
    expect(page.elements['sign-in']!.hidden).toBe(false);
    expect(page.elements['sign-in']!.disabled).toBe(false);
    expect([...page.storage.values()].join('')).not.toContain('Token');
    expect((await page.query()).errors?.[0]?.extensions.code).toBe(
      'UNAUTHENTICATED',
    );
  },
);

test('an unsolicited or replayed callback cannot establish an editor session', async () => {
  const initial = await editor();
  const auth = await authorization(initial);
  const accepted = await editor(auth.callback, initial.storage);
  expect(accepted.status).toBe('Signed in.');
  for (const storage of [initial.storage, new Map<string, string>()]) {
    const rejected = await editor(auth.callback, storage);
    expect(rejected.status).toContain('Sign-in failed');
    expect(
      rejected.requests.some((request) => request.path.endsWith('/exchange')),
    ).toBe(false);
  }
});

test('same-origin JSON is required and errors never reflect submitted tokens', async () => {
  for (const path of ['exchange', 'logout']) {
    const response = await fetch(`${origin}/graphql/auth/${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://attacker.test',
      },
      body: JSON.stringify({ idToken: 'private-token' }),
    });
    expect(response.status).toBe(403);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).not.toContain('private-token');
  }
});

test('repeat browser setup preserves CLI sign-in and supports HTTPS callbacks without relaxing native callback rules', async () => {
  const setup = {
    audience: 'urn:tour-itinerary:api',
    clientId: 'cli',
    callback: 'http://127.0.0.1:9876/callback',
    secret,
    browser: {
      clientId: 'shared-editor',
      callback: 'https://dev.example.test/graphql/auth/callback',
    },
  };
  await provisionOidc(database.migration, setup);
  await provisionOidc(database.migration, setup);
  const tokens = await cliSignIn(
    { ...setup, issuer: `${origin}/auth` },
    credentials,
  );
  expect(tokens.access_token).toBeTruthy();
  for (const callback of [
    'http://remote.test/graphql/auth/callback',
    'https://dev.example.test/wrong',
    'https://user@dev.example.test/graphql/auth/callback',
  ])
    await expect(
      provisionOidc(database.migration, {
        ...setup,
        browser: { clientId: 'shared-editor', callback },
      }),
    ).rejects.toThrow('GraphiQL');
  await expect(
    provisionOidc(database.migration, {
      ...setup,
      browser: { ...setup.browser, clientId: 'cli' },
    }),
  ).rejects.toThrow('distinct');
  await expect(
    provisionOidc(database.migration, {
      ...setup,
      callback: 'https://dev.example.test/callback',
    }),
  ).rejects.toThrow('HTTP loopback');
});
