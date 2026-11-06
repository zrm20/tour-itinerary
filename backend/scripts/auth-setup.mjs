import pg from 'pg';
import { randomUUID } from 'node:crypto';

/** Explicit, idempotent setup; never called by startup or ordinary reads. */
export async function provisionOidc(
  connectionString,
  { audience, clientId, callback, lifetime = 1800 },
) {
  const redirect = new URL(callback);
  if (
    redirect.protocol !== 'http:' ||
    !['localhost', '127.0.0.1', '[::1]'].includes(redirect.hostname) ||
    redirect.pathname !== '/callback' ||
    redirect.search ||
    redirect.hash
  )
    throw new Error('OIDC_CALLBACK_URL must be an HTTP loopback /callback URL');
  if (
    !clientId ||
    !Number.isInteger(lifetime) ||
    lifetime < 1 ||
    lifetime > 86400 ||
    new URL(audience).hash
  )
    throw new Error('Invalid explicit OIDC setup configuration');
  const client = new pg.Client({
    connectionString,
    connectionTimeoutMillis: 5000,
    statement_timeout: 5000,
    query_timeout: 6000,
  });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO "auth_oauthResource" (id, identifier, name, "accessTokenTtl", "allowedScopes", "signingAlgorithm", "createdAt", "updatedAt")
      VALUES ($1, $2, 'Tour Itinerary API', $3, ARRAY['openid','profile','email'], 'RS256', now(), now())
      ON CONFLICT (identifier) DO UPDATE SET "accessTokenTtl" = EXCLUDED."accessTokenTtl", "signingAlgorithm" = 'RS256', "allowedScopes" = EXCLUDED."allowedScopes", "updatedAt" = now()`,
      [randomUUID(), audience, lifetime],
    );
    await client.query(
      `INSERT INTO "auth_oauthClient" (id, "clientId", name, "skipConsent", "requirePKCE", "tokenEndpointAuthMethod", "applicationType", scopes, "grantTypes", "responseTypes", "redirectUris", "createdAt", "updatedAt")
      VALUES ($1, $2, 'Local CLI', true, true, 'none', 'native', ARRAY['openid','profile','email'], ARRAY['authorization_code'], ARRAY['code'], ARRAY[$3]::text[], now(), now())
      ON CONFLICT ("clientId") DO UPDATE SET "redirectUris" = EXCLUDED."redirectUris", "requirePKCE" = true, "skipConsent" = true, "tokenEndpointAuthMethod" = 'none', "applicationType" = 'native', scopes = EXCLUDED.scopes, "grantTypes" = EXCLUDED."grantTypes", "responseTypes" = EXCLUDED."responseTypes", "updatedAt" = now()`,
      [randomUUID(), clientId, callback],
    );
    await client.query(
      `INSERT INTO "auth_oauthClientResource" (id, "clientId", "resourceId", "createdAt") VALUES ($1,$2,$3,now()) ON CONFLICT ("clientId","resourceId") DO NOTHING`,
      [randomUUID(), clientId, audience],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}
if (process.argv[1]?.endsWith('/auth-setup.mjs')) {
  if (!process.env.MIGRATION_DATABASE_URL)
    throw new Error('Explicit MIGRATION_DATABASE_URL required');
  provisionOidc(process.env.MIGRATION_DATABASE_URL, {
    audience: process.env.API_AUDIENCE ?? 'urn:tour-itinerary:api',
    clientId: process.env.OIDC_CLIENT_ID,
    callback: process.env.OIDC_CALLBACK_URL,
    lifetime: Number(process.env.ACCESS_TOKEN_TTL_SECONDS ?? '1800'),
  }).catch(() => {
    console.error(
      'OIDC setup failed; inspect configuration and database state privately',
    );
    process.exitCode = 1;
  });
}
