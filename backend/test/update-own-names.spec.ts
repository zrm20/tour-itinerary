import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { AppModule } from '../src/app.module';
import { createServer } from 'node:net';
import { authDatabase } from './fixtures/auth-database';
import { signIn } from '../scripts/oidc-client.mjs';
import { provisionOidc } from '../scripts/auth-setup.mjs';
import { generateKeyPair, exportJWK } from 'jose';
import { symmetricEncrypt } from 'better-auth/crypto';
import pg from 'pg';

let database: Awaited<ReturnType<typeof authDatabase>>;
let issuer: string;
let app: INestApplication;
const secret = 'test-only-secret-at-least-thirty-two-characters';
const credentials = {
  email: 'names@example.test',
  password: 'test-password-12345',
};
const options = () => ({
  issuer,
  audience: 'urn:tour-itinerary:api',
  clientId: 'local-cli',
  callback: 'http://127.0.0.1:9876/callback',
});
const profileFields = 'id email firstName lastName preferredName displayName';

async function graphql(query: string, token?: string, variables?: unknown) {
  const response = await fetch(`${new URL(issuer).origin}/graphql`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(10000),
  });
  return (await response.json()) as {
    data?: {
      currentUser?: Record<string, unknown>;
      updateOwnNames?: Record<string, unknown>;
    };
    errors?: { message: string; extensions: { code: string } }[];
  };
}

async function currentUser(token: string) {
  return graphql(`{ currentUser { ${profileFields} } }`, token);
}

async function updateOwnNames(
  token: string | undefined,
  input: {
    firstName: string;
    lastName: string;
    preferredName?: string | null;
  },
) {
  return graphql(
    `mutation ($input: UpdateOwnNamesInput!) {
      updateOwnNames(input: $input) { ${profileFields} }
    }`,
    token,
    { input },
  );
}

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
      email: credentials.email,
      password: credentials.password,
      name: 'Alex',
      firstName: 'Alex',
      lastName: 'Jones',
    }),
    signal: AbortSignal.timeout(10000),
  });
  expect(signup.status, await signup.clone().text()).toBe(200);

  const other = await fetch(`${issuer}/sign-up/email`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: new URL(issuer).origin,
    },
    body: JSON.stringify({
      email: 'other@example.test',
      password: credentials.password,
      name: 'Other',
      firstName: 'Other',
      lastName: 'Person',
    }),
    signal: AbortSignal.timeout(10000),
  });
  expect(other.status, await other.clone().text()).toBe(200);
}, 60000);

afterAll(async () => {
  await app?.close();
  await database?.close();
  vi.unstubAllEnvs();
});

test('updateOwnNames requires an authenticated access token', async () => {
  const result = await updateOwnNames(undefined, {
    firstName: 'Nope',
    lastName: 'Nope',
  });
  expect(result.data?.updateOwnNames).toBeFalsy();
  expect(result.errors?.[0]?.extensions.code).toBe('UNAUTHENTICATED');
});

test('a signed-in user can update names, preferred name, and display fallback', async () => {
  const token = (await signIn(options(), credentials)).access_token;
  const before = (await currentUser(token)).data!.currentUser!;
  expect(before).toMatchObject({
    email: credentials.email,
    firstName: 'Alex',
    lastName: 'Jones',
    preferredName: null,
    displayName: 'Alex',
  });

  const updated = await updateOwnNames(token, {
    firstName: 'Alexander',
    lastName: 'Jonas',
    preferredName: 'Alex',
  });
  expect(updated.errors).toBeUndefined();
  expect(updated.data?.updateOwnNames).toMatchObject({
    id: before.id,
    email: credentials.email,
    firstName: 'Alexander',
    lastName: 'Jonas',
    preferredName: 'Alex',
    displayName: 'Alex',
  });

  const persisted = (await currentUser(token)).data!.currentUser!;
  expect(persisted).toMatchObject({
    id: before.id,
    firstName: 'Alexander',
    lastName: 'Jonas',
    preferredName: 'Alex',
    displayName: 'Alex',
  });

  const cleared = await updateOwnNames(token, {
    firstName: 'Alexander',
    lastName: 'Jonas',
    preferredName: null,
  });
  expect(cleared.data?.updateOwnNames).toMatchObject({
    id: before.id,
    firstName: 'Alexander',
    lastName: 'Jonas',
    preferredName: null,
    displayName: 'Alexander',
  });
  expect((await currentUser(token)).data!.currentUser!.displayName).toBe(
    'Alexander',
  );

  const afterLogin = (
    await currentUser((await signIn(options(), credentials)).access_token)
  ).data!.currentUser!;
  expect(afterLogin).toMatchObject({
    id: before.id,
    email: credentials.email,
    firstName: 'Alexander',
    lastName: 'Jonas',
    preferredName: null,
    displayName: 'Alexander',
  });
});

test.each(['firstName', 'lastName'] as const)(
  'updateOwnNames rejects blank %s',
  async (field) => {
    const token = (await signIn(options(), credentials)).access_token;
    const input = {
      firstName: 'Valid',
      lastName: 'Name',
      preferredName: 'Nick',
      [field]: '  ',
    };
    const result = await updateOwnNames(token, input);
    expect(result.data?.updateOwnNames).toBeFalsy();
    expect(result.errors?.[0]?.extensions.code).toBe('BAD_USER_INPUT');
    expect((await currentUser(token)).data!.currentUser).toMatchObject({
      firstName: 'Alexander',
      lastName: 'Jonas',
      preferredName: null,
    });
  },
);

test('updateOwnNames rejects a blank preferred name when provided', async () => {
  const token = (await signIn(options(), credentials)).access_token;
  const result = await updateOwnNames(token, {
    firstName: 'Alexander',
    lastName: 'Jonas',
    preferredName: '  ',
  });
  expect(result.data?.updateOwnNames).toBeFalsy();
  expect(result.errors?.[0]?.extensions.code).toBe('BAD_USER_INPUT');
});

test('updateOwnNames cannot change another user profile or login identity', async () => {
  const ownerToken = (await signIn(options(), credentials)).access_token;
  const otherToken = (
    await signIn(options(), {
      email: 'other@example.test',
      password: credentials.password,
    })
  ).access_token;
  const ownerBefore = (await currentUser(ownerToken)).data!.currentUser!;
  const otherBefore = (await currentUser(otherToken)).data!.currentUser!;

  const result = await updateOwnNames(otherToken, {
    firstName: 'Intruder',
    lastName: 'Attempt',
    preferredName: 'Nope',
  });
  expect(result.data?.updateOwnNames).toMatchObject({
    id: otherBefore.id,
    firstName: 'Intruder',
    lastName: 'Attempt',
    preferredName: 'Nope',
    displayName: 'Nope',
  });
  expect(result.data?.updateOwnNames!.id).not.toBe(ownerBefore.id);

  expect((await currentUser(ownerToken)).data!.currentUser).toMatchObject({
    id: ownerBefore.id,
    email: credentials.email,
    firstName: ownerBefore.firstName,
    lastName: ownerBefore.lastName,
    preferredName: ownerBefore.preferredName,
  });

  const stillSignsIn = await signIn(options(), credentials);
  expect(
    (await currentUser(stillSignsIn.access_token)).data!.currentUser,
  ).toMatchObject({
    id: ownerBefore.id,
    email: credentials.email,
  });
});
