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

async function myOrganizations(token?: string) {
  return graphql<{ myOrganizations: Organization[] }>(
    `
      {
        myOrganizations {
          id
          name
        }
      }
    `,
    token,
  );
}

async function organization(token: string | undefined, id: string) {
  return graphql<{ organization: Organization }>(
    `
      query ($id: ID!) {
        organization(id: $id) {
          id
          name
        }
      }
    `,
    token,
    { id },
  );
}

async function renameOrganization(
  token: string | undefined,
  id: string,
  name: string,
) {
  return graphql<{ renameOrganization: Organization }>(
    `
      mutation ($id: ID!, $name: String!) {
        renameOrganization(id: $id, name: $name) {
          id
          name
        }
      }
    `,
    token,
    { id, name },
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

test('creating an organization returns it and makes the creator its sole owner', async () => {
  const tokens = await register('owner-a@example.test', 'Owner', 'Alpha');
  const created = await createOrganization(tokens.access_token, 'Night Cage');
  expect(created.errors).toBeUndefined();
  expect(created.data!.createOrganization).toMatchObject({
    name: 'Night Cage',
  });
  expect(created.data!.createOrganization.id).toMatch(/^[0-9a-f-]{36}$/);

  const listed = await myOrganizations(tokens.access_token);
  expect(listed.data!.myOrganizations).toEqual([
    created.data!.createOrganization,
  ]);

  const read = await organization(
    tokens.access_token,
    created.data!.createOrganization.id,
  );
  expect(read.data!.organization).toEqual(created.data!.createOrganization);
});

test('one user can own multiple organizations and names may repeat', async () => {
  const tokens = await register('multi@example.test', 'Multi', 'Owner');
  const first = await createOrganization(tokens.access_token, 'Shared Name');
  const second = await createOrganization(tokens.access_token, 'Shared Name');
  expect(first.errors).toBeUndefined();
  expect(second.errors).toBeUndefined();
  expect(first.data!.createOrganization.id).not.toBe(
    second.data!.createOrganization.id,
  );
  const listed = await myOrganizations(tokens.access_token);
  expect(listed.data!.myOrganizations).toEqual(
    expect.arrayContaining([
      first.data!.createOrganization,
      second.data!.createOrganization,
    ]),
  );
  expect(listed.data!.myOrganizations).toHaveLength(2);
});

test('organization owners can rename their organization', async () => {
  const tokens = await register('rename@example.test', 'Rename', 'Owner');
  const created = await createOrganization(tokens.access_token, 'Old Name');
  const renamed = await renameOrganization(
    tokens.access_token,
    created.data!.createOrganization.id,
    'New Name',
  );
  expect(renamed.errors).toBeUndefined();
  expect(renamed.data!.renameOrganization).toEqual({
    id: created.data!.createOrganization.id,
    name: 'New Name',
  });
  expect(
    (
      await organization(
        tokens.access_token,
        created.data!.createOrganization.id,
      )
    ).data!.organization.name,
  ).toBe('New Name');
});

test('blank organization names are rejected on create and rename', async () => {
  const tokens = await register('invalid@example.test', 'Invalid', 'Input');
  for (const name of ['', '   ']) {
    const created = await createOrganization(tokens.access_token, name);
    expect(created.data?.createOrganization).toBeFalsy();
    expect(created.errors?.[0]?.extensions.code).toBe('BAD_USER_INPUT');
  }
  const valid = await createOrganization(tokens.access_token, 'Valid Org');
  for (const name of ['', '   ']) {
    const renamed = await renameOrganization(
      tokens.access_token,
      valid.data!.createOrganization.id,
      name,
    );
    expect(renamed.data?.renameOrganization).toBeFalsy();
    expect(renamed.errors?.[0]?.extensions.code).toBe('BAD_USER_INPUT');
  }
  expect(
    (await organization(tokens.access_token, valid.data!.createOrganization.id))
      .data!.organization.name,
  ).toBe('Valid Org');
});

test('unauthenticated callers cannot create, list, read, or rename organizations', async () => {
  const tokens = await register('gate@example.test', 'Gate', 'Keeper');
  const owned = await createOrganization(tokens.access_token, 'Private Org');
  const id = owned.data!.createOrganization.id;

  expect(
    (
      await graphql<{ createOrganization: Organization }>(`
        mutation {
          createOrganization(name: "Nope") {
            id
            name
          }
        }
      `)
    ).errors?.[0]?.extensions.code,
  ).toBe('UNAUTHENTICATED');
  expect((await myOrganizations()).errors?.[0]?.extensions.code).toBe(
    'UNAUTHENTICATED',
  );
  expect((await organization(undefined, id)).errors?.[0]?.extensions.code).toBe(
    'UNAUTHENTICATED',
  );
  expect(
    (await renameOrganization(undefined, id, 'Hijacked')).errors?.[0]
      ?.extensions.code,
  ).toBe('UNAUTHENTICATED');
});

test('nonowners and newly registered users cannot read or rename unrelated organizations', async () => {
  const ownerTokens = await register('org-owner@example.test', 'Org', 'Owner');
  const created = await createOrganization(
    ownerTokens.access_token,
    'Owner Only',
  );
  const orgId = created.data!.createOrganization.id;

  const strangerTokens = await register(
    'stranger@example.test',
    'Stranger',
    'User',
  );
  expect(
    (await myOrganizations(strangerTokens.access_token)).data!.myOrganizations,
  ).toEqual([]);
  expect(
    (await organization(strangerTokens.access_token, orgId)).errors?.[0]
      ?.extensions.code,
  ).toBe('FORBIDDEN');
  expect(
    (
      await renameOrganization(
        strangerTokens.access_token,
        orgId,
        'Stolen Name',
      )
    ).errors?.[0]?.extensions.code,
  ).toBe('FORBIDDEN');
  expect(
    (await organization(ownerTokens.access_token, orgId)).data!.organization
      .name,
  ).toBe('Owner Only');
});

test('users only see their own organizations across multiple accounts', async () => {
  const first = await register('alice-orgs@example.test', 'Alice', 'One');
  const second = await register('bob-orgs@example.test', 'Bob', 'Two');
  const aliceOrg = await createOrganization(first.access_token, 'Alice Band');
  const bobOrg = await createOrganization(second.access_token, 'Bob Band');

  expect(
    (await myOrganizations(first.access_token)).data!.myOrganizations,
  ).toEqual([aliceOrg.data!.createOrganization]);
  expect(
    (await myOrganizations(second.access_token)).data!.myOrganizations,
  ).toEqual([bobOrg.data!.createOrganization]);
  expect(
    (await organization(first.access_token, bobOrg.data!.createOrganization.id))
      .errors?.[0]?.extensions.code,
  ).toBe('FORBIDDEN');
  expect(
    (
      await organization(
        second.access_token,
        aliceOrg.data!.createOrganization.id,
      )
    ).errors?.[0]?.extensions.code,
  ).toBe('FORBIDDEN');
});

test('health and the infrastructure probe remain independent of organization access', async () => {
  const health = await fetch(`${origin}/health`, {
    signal: AbortSignal.timeout(5000),
  });
  expect(health.status).toBe(200);
  expect(await health.json()).toMatchObject({ status: 'ok' });

  const probe = await graphql<{
    infrastructureProbe: { message: string } | null;
  }>('{ infrastructureProbe { message } }');
  // Probe may be null/failed without seed; ensure it does not require auth.
  expect(probe.errors?.[0]?.extensions.code).not.toBe('UNAUTHENTICATED');
});

async function userId(token: string) {
  return (
    await graphql<{ currentUser: { id: string } }>(
      '{ currentUser { id } }',
      token,
    )
  ).data!.currentUser.id;
}

async function owners(token: string | undefined, id: string) {
  return graphql<{ organizationOwners: { id: string; displayName: string }[] }>(
    'query ($id: ID!) { organizationOwners(organizationId: $id) { id displayName } }',
    token,
    { id },
  );
}

async function changeOwner(
  action: 'grant' | 'remove',
  token: string | undefined,
  id: string,
  target: string,
) {
  return graphql<Record<string, boolean>>(
    `mutation ($id: ID!, $target: ID!) { ${action}OrganizationOwner(organizationId: $id, userId: $target) }`,
    token,
    { id, target },
  );
}

test('registered owners have equal authority and duplicate grants are idempotent', async () => {
  const a = (await register('share-a@example.test', 'Alice', 'Owner'))
    .access_token;
  const b = (await register('share-b@example.test', 'Bob', 'Owner'))
    .access_token;
  const c = (await register('share-c@example.test', 'Charlie', 'Owner'))
    .access_token;
  const aId = await userId(a),
    bId = await userId(b),
    cId = await userId(c);
  const org = (await createOrganization(a, 'Shared')).data!.createOrganization;
  expect((await changeOwner('grant', a, org.id, bId)).errors).toBeUndefined();
  expect((await changeOwner('grant', a, org.id, bId)).errors).toBeUndefined();
  expect((await owners(b, org.id)).data!.organizationOwners).toEqual(
    expect.arrayContaining([
      { id: aId, displayName: 'Alice' },
      { id: bId, displayName: 'Bob' },
    ]),
  );
  expect((await owners(b, org.id)).data!.organizationOwners).toHaveLength(2);
  expect((await myOrganizations(b)).data!.myOrganizations).toEqual([org]);
  expect(
    (await renameOrganization(b, org.id, 'Equal authority')).errors,
  ).toBeUndefined();
  expect((await changeOwner('grant', b, org.id, cId)).errors).toBeUndefined();
  expect((await changeOwner('remove', b, org.id, aId)).errors).toBeUndefined();
  expect((await organization(a, org.id)).errors?.[0]?.extensions.code).toBe(
    'FORBIDDEN',
  );
  expect((await myOrganizations(a)).data!.myOrganizations).toEqual([]);
  expect((await owners(a, org.id)).errors?.[0]?.extensions.code).toBe(
    'FORBIDDEN',
  );
  expect(
    (await renameOrganization(a, org.id, 'Removed owner')).errors?.[0]
      ?.extensions.code,
  ).toBe('FORBIDDEN');
  expect(
    (await changeOwner('grant', a, org.id, aId)).errors?.[0]?.extensions.code,
  ).toBe('FORBIDDEN');
  expect(
    (await changeOwner('remove', a, org.id, bId)).errors?.[0]?.extensions.code,
  ).toBe('FORBIDDEN');
  expect(await userId(a)).toBe(aId);
  expect((await changeOwner('remove', b, org.id, bId)).errors).toBeUndefined();
  expect((await owners(c, org.id)).data!.organizationOwners).toEqual([
    { id: cId, displayName: 'Charlie' },
  ]);
});

test('last-owner protection survives sequential and concurrent self-removal', async () => {
  const a = (await register('last-a@example.test', 'Last', 'Alpha'))
    .access_token;
  const b = (await register('last-b@example.test', 'Last', 'Beta'))
    .access_token;
  const aId = await userId(a),
    bId = await userId(b);
  const org = (await createOrganization(a, 'Always managed')).data!
    .createOrganization;
  expect(
    (await changeOwner('remove', a, org.id, aId)).errors?.[0]?.extensions.code,
  ).toBe('BAD_USER_INPUT');
  expect((await changeOwner('grant', a, org.id, bId)).errors).toBeUndefined();
  const outcomes = await Promise.all([
    changeOwner('remove', a, org.id, aId),
    changeOwner('remove', b, org.id, bId),
  ]);
  expect(outcomes.filter((result) => !result.errors)).toHaveLength(1);
  expect(
    outcomes.filter(
      (result) => result.errors?.[0]?.extensions.code === 'BAD_USER_INPUT',
    ),
  ).toHaveLength(1);
  const remainingToken = outcomes[0].errors ? a : b;
  expect(
    (await owners(remainingToken, org.id)).data!.organizationOwners,
  ).toHaveLength(1);
  expect(
    (await organization(remainingToken, org.id)).data!.organization.id,
  ).toBe(org.id);
});

test('ownership grants require a registered application user ID', async () => {
  const token = (await register('target-owner@example.test', 'Target', 'Owner'))
    .access_token;
  const id = (await createOrganization(token, 'Registered targets')).data!
    .createOrganization.id;
  for (const target of [
    'target-owner@example.test',
    '00000000-0000-4000-8000-000000000000',
  ]) {
    expect(
      (await changeOwner('grant', token, id, target)).errors?.[0]?.extensions
        .code,
    ).toBe('BAD_USER_INPUT');
  }
  expect((await owners(token, id)).data!.organizationOwners).toHaveLength(1);
});

test('nonowners and other organizations cannot list or manage protected owners', async () => {
  const a = (await register('private-a@example.test', 'Private', 'Alpha'))
    .access_token;
  const b = (await register('private-b@example.test', 'Private', 'Beta'))
    .access_token;
  const aId = await userId(a),
    bId = await userId(b);
  const orgA = (await createOrganization(a, 'Private A')).data!
    .createOrganization.id;
  const orgB = (await createOrganization(b, 'Private B')).data!
    .createOrganization.id;
  for (const [token, id, target] of [
    [a, orgB, bId],
    [b, orgA, aId],
  ] as const) {
    expect((await owners(token, id)).errors?.[0]?.extensions.code).toBe(
      'FORBIDDEN',
    );
    for (const action of ['grant', 'remove'] as const) {
      expect(
        (await changeOwner(action, token, id, target)).errors?.[0]?.extensions
          .code,
      ).toBe('FORBIDDEN');
    }
  }
  expect((await owners(undefined, orgA)).errors?.[0]?.extensions.code).toBe(
    'UNAUTHENTICATED',
  );
  for (const action of ['grant', 'remove'] as const) {
    expect(
      (await changeOwner(action, undefined, orgA, bId)).errors?.[0]?.extensions
        .code,
    ).toBe('UNAUTHENTICATED');
  }
  expect((await owners(a, orgA)).data!.organizationOwners).toEqual([
    { id: aId, displayName: 'Private' },
  ]);
  expect((await owners(b, orgB)).data!.organizationOwners).toEqual([
    { id: bId, displayName: 'Private' },
  ]);
});
