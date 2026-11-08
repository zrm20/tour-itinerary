# Development authentication

The backend supports email/password registration, Authorization Code with S256 PKCE, and RP-initiated current-session sign-out through its isolated Better Auth provider. The API independently validates signatures, issuer, audience, expiry and access-token kind. `currentUser` resolves a permanent application user ID through the provider identity, never by matching email. Display name uses preferred name when present, otherwise first name. There are no authentication screens or unrestricted client-registration endpoints. Sign-out ends only the current provider session; already-issued JWTs may remain usable until expiry.

## Local setup

Complete [local database setup](persistence.md#start-locally), including explicit migrations and fixture seeding. In `backend/.env`, uncomment `AUTH_ISSUER=http://127.0.0.1:3000/auth` and supply a private randomly generated `AUTH_SECRET` of at least 32 characters. Keep it stable: it protects sessions and encrypts persisted signing keys. Keep separate runtime and migration URLs.

`API_AUDIENCE` defaults to `urn:tour-itinerary:api`. `ACCESS_TOKEN_TTL_SECONDS` accepts an integer from 1 to 86400 and defaults to 1800 (30 minutes). Restart after changes; newly issued tokens use the configured lifetime, while existing tokens retain their expiry.

From `backend/`:

```sh
npm run auth:setup
npm run start:dev
```

Explicit setup requires `MIGRATION_DATABASE_URL`, `AUTH_SECRET`, `OIDC_CLIENT_ID` and `OIDC_CALLBACK_URL`. It registers the configured API resource and native public client with required PKCE, and provisions an encrypted RS256 signing key. It is transactional and repeatable, updating the selected client's settings while preserving existing live keys. The example callback is `http://127.0.0.1:9876/callback`; only HTTP loopback `/callback` URLs are accepted. Never invoke setup implicitly at startup or on ordinary reads.

Register interactively from `backend/`:

```sh
npm run auth:register
```

The CLI prompts for email, a password masked with `*` characters, first name, last name and an optional preferred name (press Enter to skip). Email, password, first name and last name are required; there is no username, manual approval or email verification. Emails remain unverified. The CLI prints only registration status, never the signup response's private session token.

Then sign in and read the permanent application profile:

```sh
npm run auth:signin
```

Sign out of the current provider session:

```sh
npm run auth:signout
```

Sign-in and sign-out prompt for email and a password masked with `*` characters. Press Enter to submit each field. Registration re-prompts for passwords shorter than eight characters. These commands announce when the HTTP request starts and report success or failure. The reusable CLI performs callback/state checks, code exchange with PKCE and ID-token nonce validation, then either calls GraphQL with the access token or ends that session through the provider's RP-initiated logout endpoint. Sign-in prints only the profile and permanent application ID. Sign-out discards local tokens after ending the current provider session; it does not end other sessions, and an already-issued access token may remain usable at the API until expiry. No credentials or tokens are saved. The CLI follows the callback internally without a browser or callback listener. Ctrl+C cancels a prompt.

These commands reuse supplied `OIDC_EMAIL` and `OIDC_PASSWORD` values, prompting only for missing fields. Registration also accepts `OIDC_FIRST_NAME`, `OIDC_LAST_NAME` and optional `OIDC_PREFERRED_NAME`. Supply these privately through the environment or gitignored `.env` for noninteractive use; missing required fields fail clearly when no interactive terminal is available. Explicit `auth:setup` enables end-session for the trusted local client so sign-out can use the protocol boundary.

Other clients send `Authorization: Bearer ACCESS_TOKEN` to `POST /graphql`:

```graphql
query {
  currentUser {
    id
    email
    firstName
    lastName
    preferredName
    displayName
  }
}
```

ID tokens and provider session tokens are rejected as API access tokens. Health and the infrastructure probe remain public. Leaving `AUTH_ISSUER` unset disables authentication and retains database-free startup and health. No startup or ordinary read migrates, seeds or provisions authentication.

## Shared development

Use the existing [pause/drain/maintenance process](operations/google-cloud.md#pause-and-resume-releases) and [persistence activation](operations/neon.md). Authentication adds a separate opt-in Terraform gate, disabled by default. Apply reviewed secret-container preparation first. An engineer supplies at least 32 random characters directly to the individual `api-auth-secret` Secret Manager secret, recording only its numeric version. Terraform manages the container and runtime-only Secret Accessor grant, never its value; delivery has no direct access.

With releases paused and drained, apply reviewed migrations through the existing restricted migration path. Privately invoke `node backend/scripts/auth-setup.mjs` with the direct migration URL, selected auth secret, deliberate client ID/callback and matching API audience. This is an explicit operator action outside routine delivery. Do not load a local `.env` against shared targets. Runtime and the sign-in CLI never receive migration credentials.

Review Terraform inputs `enable_authentication = true`, `auth_secret_version`, `auth_issuer`, `api_audience` and `access_token_ttl_seconds`. Use the stable normal HTTPS service URL followed by `/auth` as issuer, including when requests reach a tagged candidate revision. Preserve the existing persistence gate and pinned database-secret versions. Apply, privately verify health/probe and authentication, then resume releases. Routine delivery retains its existing migration/seed checks and does not run Terraform or provision authentication.

Keep secrets out of plans, state, workflow variables, logs and issues. Changing `AUTH_SECRET` affects encrypted keys and sessions: an engineer must plan compatible re-encryption/key provisioning and retained rollback revisions. Merely changing its secret version is not a signing-key migration.

## Verification

Vitest HTTP tests use disposable PostgreSQL and real provider/token issuance. Follow [database verification](persistence.md#verification), including `TEST_ADMIN_DATABASE_URL`, then run `npm test -- test/authentication.spec.ts`. Production image health checks remain independent of database and authentication secrets.
