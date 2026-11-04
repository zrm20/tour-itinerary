# Local persistence

The API still serves only `/health` and starts without database configuration. PostgreSQL and Prisma provide the local persistence foundation; hosted migration delivery is prepared behind a disabled-by-default engineer gate, with no mandatory runtime connection. See [shared development persistence](operations/neon.md). Only the dedicated non-sensitive infrastructure fixture is modeled. GraphQL and application-domain persistence are absent.

## Versions and connections

Use PostgreSQL **17.6** (`postgres:17.6-bookworm`) in Compose and CI. PostgreSQL **17** is the intended Neon major; hosted setup remains engineer operated. Prisma client, CLI and PostgreSQL adapter are pinned together at **7.10.1**, a stable release compatible with the pinned Node 24.22.2. Prisma 7 uses `prisma.config.ts` for migration/shadow URLs and the `prisma-client` generator with a PostgreSQL driver adapter for runtime queries.

`DATABASE_URL` is the future runtime SELECT-only connection, `MIGRATION_DATABASE_URL` is the separate direct owner connection, and `SHADOW_DATABASE_URL` is exclusively for local migration authoring. `TEST_ADMIN_DATABASE_URL` is a local disposable-test provisioner, never the application connection. The health-only application does not consume these settings. Never put hosted credentials in local values or PR CI. Activated keyless delivery fetches only the selected migration Secret Manager version.

## Start locally

Run Nest natively; Compose runs only PostgreSQL. From `backend/`, using the pinned Node/npm toolchain:

```sh
npm ci
cp .env.example .env  # once; preserve an existing file
# Starts a persistent named volume and initializes local roles/databases once.
docker compose up -d --wait
npm run db:deploy
npm run db:seed
npm run start:dev
```

The Compose port binds only to loopback. Its fixed passwords are disposable local credentials. Keep local development data in the named volume; `docker compose down` preserves it. The initializer runs only on an empty volume. Do not use Compose passwords in shared environments.

`db:deploy` replays committed migrations; `db:seed` explicitly upserts internal key `infrastructure-probe` with `Infrastructure probe ready.`. Repeating seed restores canonical text and preserves other rows. Neither startup nor reads invoke migration/seed, repair a missing fixture, write, or cache the result.

Author migrations with `npm run db:dev`, using `it_local` and the separate `it_shadow` database. Review and commit the source schema, generated migration SQL and lockfile. Never use development, test or shared data as a shadow target. Never edit a migration already successfully applied to a shared database; add a new reviewed migration. Migration SQL requires the two roles to exist before replay.

To deliberately erase **only local development data**, run `npm run db:reset`, then `npm run db:seed`. Reset drops/replays the local schema and does not seed implicitly. It does not delete the Compose volume or shared data. Database commands validate loopback hosts, exact local/test names, role identity and absence of URL query overrides before connecting. Reset accepts only `it_local` or explicitly named disposable `it_test_<pid>` databases; migration authoring also requires exactly `it_shadow`. Shared/ambiguous targets are refused. Do not use raw destructive Prisma or Docker volume commands against shared environments.

## Roles and grants

`backend/database/roles.sql` creates limited migration and runtime login roles. Set passwords separately; committed SQL contains no shared credentials. The administrator creates each database owned by `it_migration`, then runs `database/permissions.sql` **in that database**, supplying its name as the psql variable `database`:

```sh
psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 -v database=it_local -f database/permissions.sql
```

The migration login owns the database and fixture table and can migrate/seed and grant access. It has no superuser, role creation, replication or database creation power. Runtime gets only CONNECT, public schema USAGE and fixture SELECT. PUBLIC loses database and schema grants. The migration grants SELECT on the fixture explicitly; no broad default grants authorize future tables. The runtime cannot write, create schema objects or alter/drop the fixture. Local administrative credentials are used only for initial setup/test database creation, never by the provider. Shared role/password/bootstrap and deployment configuration require the separate engineer checkpoint described in the [Neon operating guide](operations/neon.md).

## Verification

Supply the disposable test provisioner explicitly; tests never load `.env`:

```sh
TEST_ADMIN_DATABASE_URL=postgresql://it_admin:local-admin@127.0.0.1:5432/it_admin npm run check
# A focused run:
TEST_ADMIN_DATABASE_URL=postgresql://it_admin:local-admin@127.0.0.1:5432/it_admin npm test -- test/persistence.spec.ts
```

`npm run check` itself does not start or depend on Docker: it needs an already running, isolated PostgreSQL instance. Compose is the documented local way to supply one. CI supplies a fresh PostgreSQL service per job and initializes the same roles. Missing test configuration fails, rather than silently skipping persistence checks. Tests are serialized. Each run creates a fresh `it_test_<pid>` database, applies committed migrations with `migrate deploy`, seeds explicitly, and drops only that database in teardown. No `db push`, shared credentials, or shared database failure injection is involved.

Integration tests cover clean migration replay and reset/replay, bounded connection failure/recovery, canonical read, changed/missing fixture without repair, repeated seed restoration/unrelated-row preservation, and runtime write/DDL denial. Existing HTTP/startup tests and production image checks verify DB-free health. Generation runs automatically before development, type checking, tests and production build; it needs neither database connectivity nor deployment secrets. Generated Prisma TypeScript is ignored, compiled into `dist/`, and bundled with runtime dependencies in the image.

The small `FixturePersistence` provider owns Prisma and returns only the stored message or null. It connects lazily, uses at most two connections, a 5-second connection timeout, 5-second server statement timeout, 6-second driver query timeout and 10-second idle timeout, with no application retries. At Cloud Run's existing maximum of two instances this would allow four runtime connections; hosted activation must review that budget. Errors are for the caller to sanitize; this checkpoint exposes no database endpoint or diagnostic response.
