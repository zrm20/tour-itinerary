import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createServer } from 'node:net';
import { vi } from 'vitest';
import { generateKeyPair, exportJWK, decodeJwt } from 'jose';
import { symmetricEncrypt } from 'better-auth/crypto';
import pg from 'pg';
import { AppModule } from '../src/app.module';
import { authDatabase } from './fixtures/auth-database';
import {
  signIn,
  authorizationRequest,
  callbackCode,
  exchangeCode,
} from '../scripts/oidc-client.mjs';
import { provisionOidc } from '../scripts/auth-setup.mjs';

let database: Awaited<ReturnType<typeof authDatabase>>;
let issuer: string;
let app: INestApplication;
let replica: INestApplication;
let replicaOrigin: string;
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
  base = origin,
) {
  const response = await fetch(`${base}/graphql`, {
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
  const replicaModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  replica = replicaModule.createNestApplication();
  await replica.listen(0, '127.0.0.1');
  replicaOrigin = await replica.getUrl();
}, 60000);

afterAll(async () => {
  await replica?.close();
  await app?.close();
  await database?.close();
  vi.unstubAllEnvs();
});

test('only organization owners can permanently delete tours and preserve sibling data', async () => {
  const owner = (await register('delete-owner@example.test', 'Owner', 'One'))
    .access_token;
  const admin = (await register('delete-admin@example.test', 'Admin', 'One'))
    .access_token;
  const member = (await register('delete-member@example.test', 'Member', 'One'))
    .access_token;
  const stranger = (
    await register('delete-stranger@example.test', 'Other', 'One')
  ).access_token;
  const org = (await createOrganization(owner, 'Retained')).data!
    .createOrganization.id;
  const tour = await createTour(owner, org);
  const sibling = await createTour(owner, org);
  for (const [token, role] of [
    [admin, 'Admin'],
    [member, 'Member'],
  ] as const) {
    await grantAccess(owner, tour, await idOf(token), role);
    await grantAccess(owner, sibling, await idOf(token), role);
  }
  for (const token of [admin, member, stranger, undefined]) {
    const result = await remove('Tour', token, tour);
    expect(result.errors?.[0]?.extensions.code).toBe(
      token ? 'FORBIDDEN' : 'UNAUTHENTICATED',
    );
    expect((await readTour(owner, tour)).errors).toBeUndefined();
  }
  expect((await remove('Tour', owner, tour)).data).toEqual({
    deleteTour: true,
  });
  for (const token of [owner, admin, member]) {
    expect((await readTour(token, tour)).errors?.[0]?.extensions.code).toBe(
      'FORBIDDEN',
    );
    expect((await readTour(token, sibling)).errors).toBeUndefined();
    expect(await idOf(token)).toBeTruthy();
    expect(
      (
        await graphql<{ myTours: { id: string }[] }>(
          '{ myTours { id } }',
          token,
        )
      ).data!.myTours,
    ).toEqual([{ id: sibling }]);
  }
  expect((await remove('Tour', owner, tour)).errors?.[0]?.extensions.code).toBe(
    'FORBIDDEN',
  );
});

async function idOf(token: string) {
  return (
    await graphql<{ currentUser: { id: string } }>(
      '{ currentUser { id } }',
      token,
    )
  ).data!.currentUser.id;
}
async function createTour(token: string, org: string) {
  const result = await graphql<{ createTour: { id: string } }>(
    'mutation ($org: ID!) { createTour(organizationId: $org, name: "Tour") { id } }',
    token,
    { org },
  );
  expect(result.errors).toBeUndefined();
  return result.data!.createTour.id;
}
async function grantAccess(
  token: string,
  tour: string,
  user: string,
  role: 'Admin' | 'Member',
) {
  const result = await graphql(
    `mutation ($tour: ID!, $user: ID!) { grantTour${role}(tourId: $tour, userId: $user) { userId } }`,
    token,
    { tour, user },
  );
  expect(result.errors).toBeUndefined();
}
async function readTour(token: string, id: string) {
  return graphql('query ($id: ID!) { tour(id: $id) { id } }', token, { id });
}
async function remove(
  entity: 'Tour' | 'Organization',
  token: string | undefined,
  id: string,
) {
  return graphql(`mutation ($id: ID!) { delete${entity}(id: $id) }`, token, {
    id,
  });
}

async function grantOwner(token: string, org: string, user: string) {
  const result = await graphql(
    'mutation ($org: ID!, $user: ID!) { grantOrganizationOwner(organizationId: $org, userId: $user) }',
    token,
    { org, user },
  );
  expect(result.errors).toBeUndefined();
}

test('any current owner can delete an organization and all its tours without removing users or unrelated work', async () => {
  const founder = (
    await register('org-delete-founder@example.test', 'Founder', 'One')
  ).access_token;
  const owner = (
    await register('org-delete-owner@example.test', 'Equal', 'Owner')
  ).access_token;
  const admin = (
    await register('org-delete-admin@example.test', 'Admin', 'One')
  ).access_token;
  const member = (
    await register('org-delete-member@example.test', 'Member', 'One')
  ).access_token;
  const org = (await createOrganization(founder, 'Deleted')).data!
    .createOrganization.id;
  const other = (await createOrganization(founder, 'Retained')).data!
    .createOrganization.id;
  await grantOwner(founder, org, await idOf(owner));
  const tours = [
    await createTour(founder, org),
    await createTour(founder, org),
  ];
  const retained = await createTour(founder, other);
  for (const tour of [...tours, retained]) {
    await grantAccess(founder, tour, await idOf(admin), 'Admin');
    await grantAccess(founder, tour, await idOf(member), 'Member');
  }
  for (const token of [admin, member, undefined]) {
    expect(
      (await remove('Organization', token, org)).errors?.[0]?.extensions.code,
    ).toBe(token ? 'FORBIDDEN' : 'UNAUTHENTICATED');
  }
  expect((await remove('Organization', owner, org)).data).toEqual({
    deleteOrganization: true,
  });
  for (const token of [founder, owner, admin, member]) {
    expect(await idOf(token)).toBeTruthy();
    expect(
      (
        await graphql(
          'query ($id: ID!) { organization(id: $id) { id } }',
          token,
          { id: org },
        )
      ).errors?.[0]?.extensions.code,
    ).toBe('FORBIDDEN');
    for (const tour of tours)
      expect((await readTour(token, tour)).errors?.[0]?.extensions.code).toBe(
        'FORBIDDEN',
      );
  }
  for (const token of [founder, admin, member])
    expect((await readTour(token, retained)).errors).toBeUndefined();
  expect(
    (
      await graphql<{ myOrganizations: { id: string }[] }>(
        '{ myOrganizations { id } }',
        founder,
      )
    ).data!.myOrganizations,
  ).toEqual([{ id: other }]);
  expect((await remove('Organization', founder, other)).data).toEqual({
    deleteOrganization: true,
  });
  expect((await readTour(founder, retained)).errors?.[0]?.extensions.code).toBe(
    'FORBIDDEN',
  );
});

async function deleteSelf(token?: string, base?: string) {
  return graphql('mutation { deleteOwnUser }', token, undefined, base);
}

test('self-deletion rejects sole ownership in any organization and preserves sign-in and access', async () => {
  const email = 'self-sole@example.test';
  const token = (await register(email, 'Sole', 'Owner')).access_token;
  const other = (await register('self-other@example.test', 'Other', 'Owner'))
    .access_token;
  const user = await idOf(token);
  const shared = (await createOrganization(token, 'Shared')).data!
    .createOrganization.id;
  await grantOwner(token, shared, await idOf(other));
  const sole = (await createOrganization(token, 'Sole')).data!
    .createOrganization.id;
  const tour = await createTour(token, sole);
  await grantAccess(token, tour, user, 'Admin');
  expect((await deleteSelf()).errors?.[0]?.extensions.code).toBe(
    'UNAUTHENTICATED',
  );
  expect((await deleteSelf(token)).errors?.[0]?.extensions.code).toBe(
    'BAD_USER_INPUT',
  );
  expect(await idOf(token)).toBe(user);
  expect(
    await idOf((await signIn(options(), { email, password })).access_token),
  ).toBe(user);
  expect((await readTour(token, tour)).errors).toBeUndefined();
  expect(
    (
      await graphql<{ tourAccess: { userId: string }[] }>(
        'query ($tour: ID!) { tourAccess(tourId: $tour) { userId } }',
        token,
        { tour },
      )
    ).data!.tourAccess,
  ).toEqual([{ userId: user }]);
  await grantOwner(token, sole, await idOf(other));
  expect((await deleteSelf(token)).data).toEqual({ deleteOwnUser: true });
  expect(
    (await graphql('{ currentUser { id } }', token)).errors?.[0]?.extensions
      .code,
  ).toBe('UNAUTHENTICATED');
  for (const org of [shared, sole]) {
    expect(
      (
        await graphql(
          'query ($id: ID!) { organization(id: $id) { id } }',
          other,
          { id: org },
        )
      ).errors,
    ).toBeUndefined();
  }
  expect((await readTour(other, tour)).errors).toBeUndefined();
  await expect(signIn(options(), { email, password })).rejects.toThrow(
    'sign-in rejected',
  );
  const replacement = (await register(email, 'New', 'User')).access_token;
  expect(await idOf(replacement)).not.toBe(user);
  expect(
    (await graphql('{ myOrganizations { id } myTours { id } }', replacement))
      .data,
  ).toEqual({ myOrganizations: [], myTours: [] });
  expect(
    (await graphql('{ currentUser { id } }', token)).errors?.[0]?.extensions
      .code,
  ).toBe('UNAUTHENTICATED');
});

async function ownerConnection() {
  const connection = new pg.Client({ connectionString: database.migration });
  await connection.connect();
  return connection;
}

async function pendingCode(email: string) {
  const request = authorizationRequest(options());
  const response = await fetch(request.url, { redirect: 'manual' });
  const redirect = (await response.json()) as { url: string };
  const login = new URL(redirect.url, issuer);
  const signedIn = await postAuth('/sign-in/email', {
    email,
    password,
    oauth_query: login.search.slice(1),
  });
  expect(signedIn.ok).toBe(true);
  const body = (await signedIn.json()) as { url: string };
  return {
    request,
    code: callbackCode(body.url, request),
    cookie: signedIn.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; '),
  };
}
async function session(cookie: string) {
  return (await fetch(`${issuer}/get-session`, { headers: { cookie } })).json();
}

test('self-deletion cleans every linked local identity and outstanding code while preserving shared authentication infrastructure', async () => {
  const email = 'linked-primary@example.test';
  const primary = (await register(email, 'Linked', 'Primary')).access_token;
  const linkedEmail = 'linked-secondary@example.test';
  const linked = (await register(linkedEmail, 'Linked', 'Secondary'))
    .access_token;
  const survivorEmail = 'linked-survivor@example.test';
  const survivor = (await register(survivorEmail, 'Linked', 'Survivor'))
    .access_token;
  const id = await idOf(primary);
  const extraId = await idOf(linked);
  const survivorId = await idOf(survivor);
  const subjects = [decodeJwt(primary).sub!, decodeJwt(linked).sub!];
  const org = (await createOrganization(survivor, 'Preserved')).data!
    .createOrganization.id;
  const tour = await createTour(survivor, org);
  await grantAccess(survivor, tour, id, 'Member');
  const connection = await ownerConnection();
  try {
    // There is intentionally no public account-linking endpoint. Arrange an
    // already linked identity to prove cleanup follows every persisted mapping.
    await connection.query(
      'UPDATE provider_identity SET "userId" = $1 WHERE "userId" = $2',
      [id, extraId],
    );
    await connection.query('DELETE FROM application_user WHERE id = $1', [
      extraId,
    ]);
    // Shared clients survive removal of a user recorded as their administrator.
    await connection.query(
      'UPDATE "auth_oauthClient" SET "userId" = $1 WHERE "clientId" = $2',
      [subjects[0], 'local-cli'],
    );
    // These persisted token/consent variants are not all emitted by the
    // enabled authorization-code-only HTTP flow, but still require cleanup.
    for (const subject of [...subjects, decodeJwt(survivor).sub!]) {
      await connection.query(
        'INSERT INTO "auth_oauthRefreshToken" (id, token, "clientId", "userId", resources, "requestedUserInfoClaims", scopes) VALUES ($1, $2, $3, $4, $5, $5, $5)',
        [
          `refresh-${subject}`,
          `refresh-secret-${subject}`,
          'local-cli',
          subject,
          ['openid'],
        ],
      );
      await connection.query(
        'INSERT INTO "auth_oauthAccessToken" (id, token, "clientId", "userId", "refreshId", resources, "requestedUserInfoClaims", scopes) VALUES ($1, $2, $3, $4, $5, $6, $6, $6)',
        [
          `access-${subject}`,
          `access-secret-${subject}`,
          'local-cli',
          subject,
          `refresh-${subject}`,
          ['openid'],
        ],
      );
      await connection.query(
        'INSERT INTO "auth_oauthConsent" (id, "clientId", "userId", resources, "requestedUserInfoClaims", scopes) VALUES ($1, $2, $3, $4, $4, $4)',
        [`consent-${subject}`, 'local-cli', subject, ['openid']],
      );
    }
    await connection.query(
      "INSERT INTO auth_verification (id, identifier, value, \"expiresAt\", \"createdAt\", \"updatedAt\") VALUES ('unrelated-opaque', 'unrelated-opaque', 'opaque-value', now() + interval '1 hour', now(), now())",
    );
    const survivorBefore = await authCounts(decodeJwt(survivor).sub!);
    expect(await authCounts(subjects[0]!)).toMatchObject({
      auth_user: 1,
      auth_account: 1,
      auth_oauthAccessToken: 1,
      auth_oauthRefreshToken: 1,
      auth_oauthConsent: 1,
    });
    const pending = await pendingCode(email);
    const otherPending = await pendingCode(survivorEmail);
    expect(await session(pending.cookie)).toBeTruthy();
    expect((await deleteSelf(primary)).data).toEqual({ deleteOwnUser: true });
    expect(await session(pending.cookie)).toBeNull();
    expect(
      (
        await connection.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM auth_verification WHERE id = 'unrelated-opaque'",
        )
      ).rows[0]!.count,
    ).toBe(1);
    expect(await authCounts(decodeJwt(survivor).sub!)).toMatchObject({
      auth_user: survivorBefore.auth_user,
      auth_account: survivorBefore.auth_account,
      auth_oauthRefreshToken: survivorBefore.auth_oauthRefreshToken,
      auth_oauthAccessToken: survivorBefore.auth_oauthAccessToken,
    });
    await expect(exchangeCode(pending.request, pending.code)).rejects.toThrow(
      'exchange rejected',
    );
    const retainedTokens = await exchangeCode(
      otherPending.request,
      otherPending.code,
    );
    expect(await idOf(retainedTokens.access_token)).toBe(survivorId);
    for (const token of [primary, linked])
      expect(
        (await graphql('{ currentUser { id } }', token)).errors?.[0]?.extensions
          .code,
      ).toBe('UNAUTHENTICATED');
    for (const address of [email, linkedEmail])
      await expect(
        signIn(options(), { email: address, password }),
      ).rejects.toThrow('sign-in rejected');
    for (const table of [
      'auth_user',
      'auth_account',
      'auth_session',
      'auth_oauthConsent',
      'auth_oauthAccessToken',
      'auth_oauthRefreshToken',
    ]) {
      const field = table === 'auth_user' ? 'id' : 'userId';
      expect(
        (
          await connection.query<{ count: number }>(
            `SELECT count(*)::int AS count FROM "${table}" WHERE "${field}" = ANY($1::text[])`,
            [subjects],
          )
        ).rows[0]!.count,
      ).toBe(0);
    }
    expect(
      (
        await connection.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM auth_verification WHERE CASE WHEN pg_input_is_valid(value, 'jsonb') THEN value::jsonb ->> 'userId' END = ANY($1::text[])",
          [subjects],
        )
      ).rows[0]!.count,
    ).toBe(0);
    expect(
      (
        await connection.query<{ count: number }>(
          'SELECT count(*)::int AS count FROM provider_identity WHERE "userId" = $1',
          [id],
        )
      ).rows[0]!.count,
    ).toBe(0);
    expect(
      (
        await connection.query<{ count: number }>(
          'SELECT count(*)::int AS count FROM application_user WHERE id = $1',
          [id],
        )
      ).rows[0]!.count,
    ).toBe(0);
    expect(
      (
        await connection.query<{ count: number }>(
          'SELECT count(*)::int AS count FROM tour_access WHERE "userId" = $1',
          [id],
        )
      ).rows[0]!.count,
    ).toBe(0);
    expect(
      (
        await connection.query<{ count: number }>(
          'SELECT count(*)::int AS count FROM auth_jwks',
        )
      ).rows[0]!.count,
    ).toBe(1);
    expect(
      (
        await connection.query<{ count: number }>(
          'SELECT count(*)::int AS count FROM "auth_oauthResource"',
        )
      ).rows[0]!.count,
    ).toBeGreaterThan(0);
    expect(
      await idOf(
        (await signIn(options(), { email: survivorEmail, password }))
          .access_token,
      ),
    ).toBe(survivorId);
    expect((await readTour(survivor, tour)).errors).toBeUndefined();
  } finally {
    await connection.end();
  }
});

test('explicit organization deletion unblocks sole-owner self-deletion and no operation can target another user', async () => {
  const token = (
    await register('explicit-self@example.test', 'Explicit', 'Owner')
  ).access_token;
  const other = (await register('explicit-other@example.test', 'Other', 'User'))
    .access_token;
  const otherId = await idOf(other);
  const org = (await createOrganization(token, 'Explicit deletion')).data!
    .createOrganization.id;
  expect((await deleteSelf(token)).errors?.[0]?.extensions.code).toBe(
    'BAD_USER_INPUT',
  );
  expect(
    (
      await graphql(
        'mutation ($id: ID!) { deleteOwnUser(userId: $id) }',
        token,
        { id: otherId },
      )
    ).errors,
  ).toBeTruthy();
  expect(await idOf(other)).toBe(otherId);
  expect((await remove('Organization', token, org)).data).toEqual({
    deleteOrganization: true,
  });
  expect((await deleteSelf(token)).data).toEqual({ deleteOwnUser: true });
});

async function failDeletion(
  table: 'tour' | 'organization' | 'application_user' | 'auth_user',
  id: string,
) {
  expect(id).toMatch(/^[a-zA-Z0-9-]+$/);
  const connection = await ownerConnection();
  await connection.query(
    `CREATE FUNCTION reject_test_deletion() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'controlled deletion failure'; END $$`,
  );
  await connection.query(
    `CREATE TRIGGER reject_test_deletion AFTER DELETE ON "${table}" FOR EACH ROW WHEN (OLD.id = '${id}') EXECUTE FUNCTION reject_test_deletion()`,
  );
  return async () => {
    await connection.query(`DROP TRIGGER reject_test_deletion ON "${table}"`);
    await connection.query('DROP FUNCTION reject_test_deletion()');
    await connection.end();
  };
}

async function authCounts(subject: string) {
  const connection = await ownerConnection();
  try {
    const counts: Record<string, number> = {};
    for (const table of [
      'auth_user',
      'auth_account',
      'auth_session',
      'auth_oauthConsent',
      'auth_oauthAccessToken',
      'auth_oauthRefreshToken',
    ]) {
      const field = table === 'auth_user' ? 'id' : 'userId';
      counts[table] = (
        await connection.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM "${table}" WHERE "${field}" = $1`,
          [subject],
        )
      ).rows[0]!.count;
    }
    return counts;
  } finally {
    await connection.end();
  }
}

test('a failure after tour or organization cleanup rolls back every relationship', async () => {
  const owner = (
    await register('rollback-org@example.test', 'Rollback', 'Owner')
  ).access_token;
  const member = (
    await register('rollback-member@example.test', 'Rollback', 'Member')
  ).access_token;
  const org = (await createOrganization(owner, 'Atomic')).data!
    .createOrganization.id;
  const tour = await createTour(owner, org);
  const sibling = await createTour(owner, org);
  const userId = await idOf(member);
  await grantAccess(owner, tour, userId, 'Member');
  await grantAccess(owner, sibling, userId, 'Admin');
  for (const [table, entity, id] of [
    ['tour', 'Tour', tour],
    ['organization', 'Organization', org],
  ] as const) {
    const restore = await failDeletion(table, id);
    try {
      const result = await remove(entity, owner, id);
      expect(result.errors?.[0]?.extensions.code).toBe(
        'GRAPHQL_REQUEST_FAILED',
      );
      expect(JSON.stringify(result)).not.toMatch(
        /controlled|Prisma|postgres|DELETE|it_runtime/,
      );
      for (const retained of [tour, sibling]) {
        expect((await readTour(owner, retained)).errors).toBeUndefined();
        expect((await readTour(member, retained)).errors).toBeUndefined();
        expect(
          (
            await graphql<{ tourAccess: { userId: string }[] }>(
              'query ($tour: ID!) { tourAccess(tourId: $tour) { userId } }',
              owner,
              { tour: retained },
            )
          ).data!.tourAccess,
        ).toEqual([{ userId }]);
      }
      expect(
        (
          await graphql(
            'query ($org: ID!) { organizationOwners(organizationId: $org) { id } }',
            owner,
            { org },
          )
        ).data,
      ).toEqual({ organizationOwners: [{ id: await idOf(owner) }] });
    } finally {
      await restore();
    }
  }
  expect((await remove('Organization', owner, org)).errors).toBeUndefined();
});

test('failed authentication or application cleanup preserves the whole user, sessions, credentials, ownership and tour access', async () => {
  const email = 'rollback-self@example.test';
  const token = (await register(email, 'Rollback', 'User')).access_token;
  const other = (
    await register('rollback-coowner@example.test', 'Remaining', 'Owner')
  ).access_token;
  const userId = await idOf(token);
  const subject = decodeJwt(token).sub!;
  const org = (await createOrganization(token, 'Retained shared')).data!
    .createOrganization.id;
  await grantOwner(token, org, await idOf(other));
  const tour = await createTour(token, org);
  await grantAccess(token, tour, userId, 'Admin');
  const pending = await pendingCode(email);
  for (const [table, id] of [
    ['auth_user', subject],
    ['application_user', userId],
  ] as const) {
    const before = await authCounts(subject);
    const restore = await failDeletion(table, id);
    try {
      const result = await deleteSelf(token);
      expect(result.errors?.[0]?.extensions.code).toBe(
        'GRAPHQL_REQUEST_FAILED',
      );
      expect(JSON.stringify(result)).not.toMatch(
        /controlled|Prisma|postgres|DELETE|it_runtime/,
      );
      expect(await authCounts(subject)).toEqual(before);
      expect(await idOf(token)).toBe(userId);
      expect(await session(pending.cookie)).toBeTruthy();
      expect(
        (await graphql('{ currentUser { firstName lastName } }', token)).data,
      ).toEqual({ currentUser: { firstName: 'Rollback', lastName: 'User' } });
      expect(
        (
          await graphql<{ organizationOwners: { id: string }[] }>(
            'query ($org: ID!) { organizationOwners(organizationId: $org) { id } }',
            other,
            { org },
          )
        ).data!.organizationOwners,
      ).toContainEqual({ id: userId });
      expect(
        (
          await graphql(
            'query ($tour: ID!) { tourAccess(tourId: $tour) { userId role } }',
            other,
            { tour },
          )
        ).data,
      ).toEqual({ tourAccess: [{ userId, role: 'ADMIN' }] });
      expect(
        await idOf((await signIn(options(), { email, password })).access_token),
      ).toBe(userId);
    } finally {
      await restore();
    }
  }
  expect(
    await idOf(
      (await exchangeCode(pending.request, pending.code)).access_token,
    ),
  ).toBe(userId);
  expect((await deleteSelf(token)).data).toEqual({ deleteOwnUser: true });
});

test('concurrent self-deletions of the final owners leave exactly one owner and one usable identity', async () => {
  const a = (await register('race-final-a@example.test', 'Final', 'Alpha'))
    .access_token;
  const b = (await register('race-final-b@example.test', 'Final', 'Beta'))
    .access_token;
  const org = (await createOrganization(a, 'Always owned')).data!
    .createOrganization.id;
  await grantOwner(a, org, await idOf(b));
  const tour = await createTour(a, org);
  const results = await Promise.all([
    deleteSelf(a),
    deleteSelf(b, replicaOrigin),
  ]);
  expect(results.filter((result) => !result.errors)).toHaveLength(1);
  expect(
    results.filter(
      (result) => result.errors?.[0]?.extensions.code === 'BAD_USER_INPUT',
    ),
  ).toHaveLength(1);
  const remaining = results[0].errors ? a : b;
  const deleted = results[0].errors ? b : a;
  expect(
    (
      await graphql(
        'query ($org: ID!) { organizationOwners(organizationId: $org) { id } }',
        remaining,
        { org },
      )
    ).data,
  ).toEqual({ organizationOwners: [{ id: await idOf(remaining) }] });
  expect((await readTour(remaining, tour)).errors).toBeUndefined();
  expect(
    (await graphql('{ currentUser { id } }', deleted)).errors?.[0]?.extensions
      .code,
  ).toBe('UNAUTHENTICATED');
});

async function removeOwner(token: string, org: string, user: string) {
  return graphql(
    'mutation ($org: ID!, $user: ID!) { removeOrganizationOwner(organizationId: $org, userId: $user) }',
    token,
    { org, user },
  );
}

test('self-deletion racing the other final owner departure cannot orphan an organization', async () => {
  const a = (await register('race-depart-a@example.test', 'Depart', 'Alpha'))
    .access_token;
  const b = (await register('race-depart-b@example.test', 'Depart', 'Beta'))
    .access_token;
  const aId = await idOf(a),
    bId = await idOf(b);
  const org = (await createOrganization(a, 'Concurrent departures')).data!
    .createOrganization.id;
  await grantOwner(a, org, bId);
  const [deletion, removal] = await Promise.all([
    deleteSelf(a),
    removeOwner(b, org, bId),
  ]);
  expect([deletion, removal].filter((result) => !result.errors)).toHaveLength(
    1,
  );
  const remaining = deletion.errors ? a : b;
  expect(
    (
      await graphql(
        'query ($org: ID!) { organizationOwners(organizationId: $org) { id } }',
        remaining,
        { org },
      )
    ).data,
  ).toEqual({ organizationOwners: [{ id: deletion.errors ? aId : bId }] });
});

test('organization deletion rechecks authority against concurrent owner removal and tour creation', async () => {
  const a = (await register('race-org-a@example.test', 'Race', 'Alpha'))
    .access_token;
  const b = (await register('race-org-b@example.test', 'Race', 'Beta'))
    .access_token;
  const aId = await idOf(a),
    bId = await idOf(b);
  for (let attempt = 0; attempt < 3; attempt++) {
    const org = (await createOrganization(a, 'Deletion race')).data!
      .createOrganization.id;
    await grantOwner(a, org, bId);
    const tour = await createTour(a, org);
    const [deletion, revocation, creation, assignment] = await Promise.all([
      remove('Organization', a, org),
      removeOwner(b, org, aId),
      graphql<{ createTour: { id: string } }>(
        'mutation ($org: ID!) { createTour(organizationId: $org, name: "Racing") { id } }',
        a,
        { org },
      ),
      graphql(
        'mutation ($tour: ID!, $user: ID!) { grantTourAdmin(tourId: $tour, userId: $user) { userId } }',
        a,
        { tour, user: bId },
      ),
    ]);
    expect(
      [deletion, revocation].filter((result) => !result.errors),
    ).toHaveLength(1);
    if (!deletion.errors) {
      expect(revocation.errors?.[0]?.extensions.code).toBe('FORBIDDEN');
      expect((await readTour(b, tour)).errors?.[0]?.extensions.code).toBe(
        'FORBIDDEN',
      );
      if (creation.data)
        expect(
          (await readTour(b, creation.data.createTour.id)).errors?.[0]
            ?.extensions.code,
        ).toBe('FORBIDDEN');
    } else {
      expect(deletion.errors[0]?.extensions.code).toBe('FORBIDDEN');
      expect((await readTour(b, tour)).errors).toBeUndefined();
      expect(
        (
          await graphql(
            'query ($org: ID!) { organizationOwners(organizationId: $org) { id } }',
            b,
            { org },
          )
        ).data,
      ).toEqual({ organizationOwners: [{ id: bId }] });
    }
    for (const result of [creation, assignment])
      if (result.errors)
        expect(result.errors[0]?.extensions.code).toBe('FORBIDDEN');
  }
});

test('tour deletion racing access changes removes assignments and preserves sibling access', async () => {
  const owner = (
    await register('race-tour-owner@example.test', 'Race', 'Owner')
  ).access_token;
  const member = (
    await register('race-tour-member@example.test', 'Race', 'Member')
  ).access_token;
  const user = await idOf(member);
  const org = (await createOrganization(owner, 'Tour race')).data!
    .createOrganization.id;
  const sibling = await createTour(owner, org);
  await grantAccess(owner, sibling, user, 'Member');
  for (let attempt = 0; attempt < 3; attempt++) {
    const tour = await createTour(owner, org);
    const [deletion, grant, removal] = await Promise.all([
      remove('Tour', owner, tour),
      graphql(
        'mutation ($tour: ID!, $user: ID!) { grantTourAdmin(tourId: $tour, userId: $user) { userId } }',
        owner,
        { tour, user },
      ),
      graphql(
        'mutation ($tour: ID!, $user: ID!) { removeTourMember(tourId: $tour, userId: $user) }',
        owner,
        { tour, user },
      ),
    ]);
    expect(deletion.data).toEqual({ deleteTour: true });
    for (const result of [grant, removal])
      if (result.errors)
        expect(result.errors[0]?.extensions.code).toBe('FORBIDDEN');
    expect((await readTour(member, tour)).errors?.[0]?.extensions.code).toBe(
      'FORBIDDEN',
    );
    expect((await readTour(member, sibling)).errors).toBeUndefined();
    const connection = await ownerConnection();
    try {
      expect(
        (
          await connection.query<{ count: number }>(
            'SELECT count(*)::int AS count FROM tour_access WHERE "tourId" = $1',
            [tour],
          )
        ).rows[0]!.count,
      ).toBe(0);
    } finally {
      await connection.end();
    }
  }
});

test('self-deletion coordinates with new ownership, tour assignments and organization creation', async () => {
  const owner = (
    await register('race-create-owner@example.test', 'Race', 'Owner')
  ).access_token;
  const org = (await createOrganization(owner, 'Stable')).data!
    .createOrganization.id;
  const tour = await createTour(owner, org);
  for (let attempt = 0; attempt < 3; attempt++) {
    const token = (
      await register(`race-create-${attempt}@example.test`, 'Race', 'User')
    ).access_token;
    const user = await idOf(token);
    const [deletion, grant, assignment, creation] = await Promise.all([
      deleteSelf(token),
      graphql(
        'mutation ($org: ID!, $user: ID!) { grantOrganizationOwner(organizationId: $org, userId: $user) }',
        owner,
        { org, user },
      ),
      graphql(
        'mutation ($tour: ID!, $user: ID!) { grantTourMember(tourId: $tour, userId: $user) { userId } }',
        owner,
        { tour, user },
      ),
      createOrganization(token, 'New sole ownership'),
    ]);
    if (!deletion.errors) {
      expect(creation.errors).toBeTruthy();
      expect(
        (await graphql('{ currentUser { id } }', token)).errors?.[0]?.extensions
          .code,
      ).toBe('UNAUTHENTICATED');
      const owners = await graphql<{ organizationOwners: { id: string }[] }>(
        'query ($org: ID!) { organizationOwners(organizationId: $org) { id } }',
        owner,
        { org },
      );
      expect(owners.data!.organizationOwners).not.toContainEqual({ id: user });
      const access = await graphql<{ tourAccess: { userId: string }[] }>(
        'query ($tour: ID!) { tourAccess(tourId: $tour) { userId } }',
        owner,
        { tour },
      );
      expect(access.data!.tourAccess).not.toContainEqual({ userId: user });
    } else {
      expect(deletion.errors[0]?.extensions.code).toBe('BAD_USER_INPUT');
      expect(creation.errors).toBeUndefined();
      expect(await idOf(token)).toBe(user);
      expect(grant.errors).toBeUndefined();
      expect(assignment.errors).toBeUndefined();
    }
  }
});

test('concurrent sign-in, session creation and code exchange cannot resurrect a deleted identity', async () => {
  for (let attempt = 0; attempt < 3; attempt++) {
    const email = `race-signin-${attempt}@example.test`;
    const token = (await register(email, 'Race', 'Identity')).access_token;
    const subject = decodeJwt(token).sub!;
    const pending = await pendingCode(email);
    const outcomes = await Promise.allSettled([
      deleteSelf(token, replicaOrigin),
      signIn(options(), { email, password }),
      postAuth('/sign-in/email', { email, password }),
      exchangeCode(pending.request, pending.code),
    ]);
    const deletion = outcomes[0];
    expect(deletion.status).toBe('fulfilled');
    if (deletion.status === 'fulfilled')
      expect(deletion.value).toEqual({ data: { deleteOwnUser: true } });
    expect(
      (await graphql('{ currentUser { id } }', token)).errors?.[0]?.extensions
        .code,
    ).toBe('UNAUTHENTICATED');
    for (const index of [1, 3]) {
      const result = outcomes[index];
      if (result?.status === 'fulfilled' && 'access_token' in result.value) {
        expect(
          (await graphql('{ currentUser { id } }', result.value.access_token))
            .errors?.[0]?.extensions.code,
        ).toBe('UNAUTHENTICATED');
      }
    }
    expect(await session(pending.cookie)).toBeNull();
    await expect(signIn(options(), { email, password })).rejects.toThrow(
      'sign-in rejected',
    );
    expect(await authCounts(subject)).toEqual({
      auth_user: 0,
      auth_account: 0,
      auth_session: 0,
      auth_oauthConsent: 0,
      auth_oauthAccessToken: 0,
      auth_oauthRefreshToken: 0,
    });
    const replacement = (await register(email, 'Replacement', 'User'))
      .access_token;
    expect(
      (await graphql('{ myOrganizations { id } myTours { id } }', replacement))
        .data,
    ).toEqual({ myOrganizations: [], myTours: [] });
    expect(
      (await graphql('{ currentUser { id } }', token)).errors?.[0]?.extensions
        .code,
    ).toBe('UNAUTHENTICATED');
  }
});
