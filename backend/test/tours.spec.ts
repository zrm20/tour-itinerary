import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createServer } from 'node:net';
import { vi } from 'vitest';
import { generateKeyPair, exportJWK } from 'jose';
import { symmetricEncrypt } from 'better-auth/crypto';
import pg from 'pg';
import { AppModule } from '../src/app.module';
import { authDatabase } from './fixtures/auth-database';
import { signIn } from '../scripts/oidc-client.mjs';
import { provisionOidc } from '../scripts/auth-setup.mjs';

let database: Awaited<ReturnType<typeof authDatabase>>;
let issuer: string;
let app: INestApplication;
let origin: string;
const secret = 'test-only-secret-at-least-thirty-two-characters';
const password = 'test-password-12345';

type Organization = { id: string; name: string };
type GraphQLBody<T> = {
  data?: T;
  errors?: { message: string; extensions: { code: string } }[];
};

const options = () => ({
  issuer,
  audience: 'urn:tour-itinerary:api',
  clientId: 'local-cli',
  callback: 'http://127.0.0.1:9876/callback',
});

async function postAuth(path: string, body: unknown) {
  return fetch(`${issuer}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
}

async function register(email: string, firstName: string, lastName: string) {
  const response = await postAuth('/sign-up/email', {
    email,
    password,
    name: firstName,
    firstName,
    lastName,
  });
  expect(response.status, await response.clone().text()).toBe(200);
  return signIn(options(), { email, password });
}

async function graphql<T>(
  query: string,
  token?: string,
  variables?: Record<string, unknown>,
) {
  const response = await fetch(`${origin}/graphql`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(10000),
  });
  return (await response.json()) as GraphQLBody<T>;
}

async function createOrganization(token: string, name: string) {
  return graphql<{ createOrganization: Organization }>(
    `
      mutation ($name: String!) {
        createOrganization(name: $name) {
          id
          name
        }
      }
    `,
    token,
    { name },
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
  origin = `http://127.0.0.1:${port}`;
  vi.stubEnv('DATABASE_URL', database.runtime);
  vi.stubEnv('AUTH_ISSUER', issuer);
  vi.stubEnv('AUTH_SECRET', secret);
  vi.stubEnv('ACCESS_TOKEN_TTL_SECONDS', '1800');
  await provisionOidc(database.migration, {
    audience: 'urn:tour-itinerary:api',
    clientId: 'local-cli',
    callback: 'http://127.0.0.1:9876/callback',
    lifetime: 1800,
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
}, 60000);

afterAll(async () => {
  await app?.close();
  await database?.close();
  vi.unstubAllEnvs();
});

test('owners create tours without dates or admin assignments and read them back', async () => {
  const tokens = await register('tour-owner@example.test', 'Tour', 'Owner');
  const org = (await createOrganization(tokens.access_token, 'Band')).data!
    .createOrganization;
  const result = await graphql<{
    createTour: { id: string; name: string; organizationId: string };
  }>(
    'mutation ($org: ID!) { createTour(organizationId: $org, name: "Spring") { id name organizationId } }',
    tokens.access_token,
    { org: org.id },
  );
  expect(result.errors).toBeUndefined();
  const tour = result.data!.createTour;
  expect(tour).toMatchObject({ name: 'Spring', organizationId: org.id });
  expect(tour.id).toMatch(/^[0-9a-f-]{36}$/);
  const read = await graphql<{ tour: typeof tour }>(
    'query ($id: ID!) { tour(id: $id) { id name organizationId } }',
    tokens.access_token,
    { id: tour.id },
  );
  expect(read.data!.tour).toEqual(tour);
});

type Tour = { id: string; name: string; organizationId: string };
async function createTour(token: string, org: string, name: string) {
  return graphql<{ createTour: Tour }>(
    'mutation ($org: ID!, $name: String!) { createTour(organizationId: $org, name: $name) { id name organizationId } }',
    token,
    { org, name },
  );
}
async function myTours(token?: string) {
  return graphql<{ myTours: Tour[] }>(
    '{ myTours { id name organizationId } }',
    token,
  );
}

test('tour lists include multiple owned organizations and duplicate names without leaking other tours', async () => {
  const alice = (await register('alice-tours@example.test', 'Alice', 'Owner'))
    .access_token;
  const bob = (await register('bob-tours@example.test', 'Bob', 'Owner'))
    .access_token;
  const a = (await createOrganization(alice, 'A')).data!.createOrganization.id;
  const b = (await createOrganization(alice, 'B')).data!.createOrganization.id;
  const c = (await createOrganization(bob, 'C')).data!.createOrganization.id;
  const first = (await createTour(alice, a, 'Same')).data!.createTour;
  const second = (await createTour(alice, a, 'Same')).data!.createTour;
  const third = (await createTour(alice, b, 'Same')).data!.createTour;
  const other = (await createTour(bob, c, 'Same')).data!.createTour;
  expect(new Set([first.id, second.id, third.id]).size).toBe(3);
  const listed = await myTours(alice);
  expect(listed.errors).toBeUndefined();
  expect(listed.data!.myTours).toEqual(
    expect.arrayContaining([first, second, third]),
  );
  expect(listed.data!.myTours).toHaveLength(3);
  expect((await myTours(bob)).data!.myTours).toEqual([other]);
  const fresh = (
    await register('fresh-tour-user@example.test', 'Fresh', 'User')
  ).access_token;
  expect((await myTours(fresh)).data!.myTours).toEqual([]);
});

async function readTour(token: string | undefined, id: string) {
  return graphql<{ tour: Tour }>(
    'query ($id: ID!) { tour(id: $id) { id name organizationId } }',
    token,
    { id },
  );
}
async function renameTour(token: string | undefined, id: string, name: string) {
  return graphql<{ renameTour: Tour }>(
    'mutation ($id: ID!, $name: String!) { renameTour(id: $id, name: $name) { id name organizationId } }',
    token,
    { id, name },
  );
}

test('owners rename tours while invalid targets, names, nonowners and anonymous callers are rejected', async () => {
  const alice = (await register('rename-tour@example.test', 'Alice', 'Owner'))
    .access_token;
  const bob = (await register('stranger-tour@example.test', 'Bob', 'Owner'))
    .access_token;
  const org = (await createOrganization(alice, 'Private')).data!
    .createOrganization.id;
  const tour = (await createTour(alice, org, 'Original')).data!.createTour;
  const renamed = await renameTour(alice, tour.id, ' New name ');
  expect(renamed.errors).toBeUndefined();
  expect(renamed.data!.renameTour).toEqual({ ...tour, name: 'New name' });
  expect((await readTour(alice, tour.id)).data!.tour.name).toBe('New name');
  for (const name of ['', '   ']) {
    expect(
      (await createTour(alice, org, name)).errors?.[0]?.extensions.code,
    ).toBe('BAD_USER_INPUT');
    expect(
      (await renameTour(alice, tour.id, name)).errors?.[0]?.extensions.code,
    ).toBe('BAD_USER_INPUT');
  }
  for (const token of [alice, bob]) {
    expect(
      (await createTour(token, 'missing', 'Nope')).errors?.[0]?.extensions.code,
    ).toBe('FORBIDDEN');
    expect(
      (await readTour(token, 'missing')).errors?.[0]?.extensions.code,
    ).toBe('FORBIDDEN');
    expect(
      (await renameTour(token, 'missing', 'Nope')).errors?.[0]?.extensions.code,
    ).toBe('FORBIDDEN');
  }
  expect(
    (await createTour(bob, org, 'Nope')).errors?.[0]?.extensions.code,
  ).toBe('FORBIDDEN');
  expect((await readTour(bob, tour.id)).errors?.[0]?.extensions.code).toBe(
    'FORBIDDEN',
  );
  expect(
    (await renameTour(bob, tour.id, 'Nope')).errors?.[0]?.extensions.code,
  ).toBe('FORBIDDEN');
  expect((await myTours()).errors?.[0]?.extensions.code).toBe(
    'UNAUTHENTICATED',
  );
  expect(
    (await readTour(undefined, tour.id)).errors?.[0]?.extensions.code,
  ).toBe('UNAUTHENTICATED');
  expect(
    (await renameTour(undefined, tour.id, 'Nope')).errors?.[0]?.extensions.code,
  ).toBe('UNAUTHENTICATED');
  expect(
    (
      await graphql(
        'mutation { createTour(organizationId: "missing", name: "Nope") { id } }',
      )
    ).errors?.[0]?.extensions.code,
  ).toBe('UNAUTHENTICATED');
  expect((await readTour(alice, tour.id)).data!.tour.name).toBe('New name');
});
