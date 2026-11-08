# Development authentication

The backend supports email/password registration, Authorization Code with S256 PKCE, and RP-initiated current-session sign-out through its isolated Better Auth provider. The API independently validates signatures, issuer, audience, expiry and access-token kind. `currentUser` resolves a permanent application user ID through the provider identity, never by matching email. Display name uses preferred name when present, otherwise first name. The provider serves a minimal email/password login page for browser-based OIDC clients; there are no registration, recovery or account screens, and no unrestricted client-registration endpoints. Sign-out ends only the current provider session; already-issued JWTs may remain usable until expiry.

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

Registration and sign-in prompt for email and a password masked with `*` characters. Press Enter to submit each field. Registration re-prompts for passwords shorter than eight characters. These commands announce when the HTTP request starts and report success or failure. The reusable CLI performs callback/state checks, code exchange with PKCE and ID-token nonce validation, then calls GraphQL with the access token. Sign-in prints the profile and permanent application ID without printing tokens. The CLI follows the callback internally without a browser or callback listener. Ctrl+C cancels a prompt.

Sign-in saves only the issuer, client ID and ID-token logout handle in `.oidc-session.json` relative to the current directory. The file is created exclusively with mode `0600` and is gitignored; passwords, access tokens and refresh tokens are never saved. A subsequent sign-in refuses to overwrite it. Set `OIDC_SESSION_FILE` to use another path, such as `.oidc-session-second.json`, for an independent session. Keep custom paths private and outside version control. If an interrupted sign-in leaves an empty session file, remove that empty file before retrying.

Sign-out reads the same session file and ends that provider session through RP-initiated logout without prompting for credentials or creating another session. It verifies that the file is private, owned by the current user, and matches the configured issuer/client. After successful logout it deletes the file; failed logout retains the handle for retry. Other sessions remain active, and an already-issued access token may remain usable at the API until expiry. Sessions created before this session-file flow cannot be recovered by entering credentials again.

Registration and sign-in reuse supplied `OIDC_EMAIL` and `OIDC_PASSWORD` values, prompting only for missing fields. Registration also accepts `OIDC_FIRST_NAME`, `OIDC_LAST_NAME` and optional `OIDC_PREFERRED_NAME`. Supply these privately through the environment or gitignored `.env` for noninteractive use; missing required fields fail clearly when no interactive terminal is available. Explicit `auth:setup` enables end-session for the trusted local client so sign-out can use the protocol boundary.

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

A signed-in user can update their own first name, last name, and optional preferred name. Required names cannot be blank; preferred name may be set, changed, or cleared with `null`. The mutation returns the updated profile, including `displayName` (`preferredName` when present, otherwise `firstName`). It does not change email, password, or the permanent application ID, and cannot target another user.

```graphql
mutation {
  updateOwnNames(
    input: { firstName: "Alexander", lastName: "Jonas", preferredName: "Alex" }
  ) {
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

Authenticated users can create named organizations, list and read organizations they own, and rename an owned organization through schema-first GraphQL. Creation atomically records the permanent application user as the first organization owner. Organization names are not unique. Ownership is a user-to-organization association keyed by application user ID, never email or provider session records. Unauthenticated callers and nonowners cannot read or rename unrelated organizations.

## Browser sign-in and Postman

An unauthenticated browser authorization request redirects to the provider's login page at `/auth/login`. The page accepts only the provider's signed, unexpired continuation; a missing, altered or expired continuation shows a restart message without a form. Submitting the form sends the email, password and continuation to the provider's email sign-in, which resumes the original authorization request and redirects to the client's registered callback with a code and the original state. Incorrect credentials show a generic message and can be retried. The page sets a nonce-based Content Security Policy, forbids framing and caching, and never logs or displays credentials or tokens.

Postman reuses the native public client provisioned by `npm run auth:setup`; it needs no extra registration. Postman's embedded authorization window captures the redirect to the registered loopback callback itself, so nothing needs to listen on that port. Do not enable **Authorize using browser**: its `https://oauth.pstmn.io/v1/callback` URL is not registered and will be rejected. The client skips consent, so the flow never reaches a consent page.

Start the backend after completing [local setup](#local-setup) and registering an account with `npm run auth:register`. In a Postman request's **Authorization** tab, choose **OAuth 2.0** and configure a new token, substituting your `backend/.env` values (shown with the defaults):

| Setting                                  | Value                                                      |
| ---------------------------------------- | ---------------------------------------------------------- |
| Grant type                               | Authorization Code (With PKCE)                             |
| Callback URL                             | `OIDC_CALLBACK_URL`, e.g. `http://127.0.0.1:9876/callback` |
| Auth URL                                 | `AUTH_ISSUER` + `/oauth2/authorize`                        |
| Access Token URL                         | `AUTH_ISSUER` + `/oauth2/token`                            |
| Client ID                                | `OIDC_CLIENT_ID`                                           |
| Client Secret                            | Leave empty (public client)                                |
| Code Challenge Method                    | SHA-256                                                    |
| Code Verifier                            | Leave empty to generate one                                |
| Scope                                    | `openid profile email`                                     |
| State                                    | Any random value                                           |
| Client Authentication                    | Send client credentials in body                            |
| Advanced: Auth Request and Token Request | `resource` = `API_AUDIENCE`, e.g. `urn:tour-itinerary:api` |

Send `resource` on both requests, as the CLI does, so the provider issues a JWT access token for the API audience. Use the exact host from `AUTH_ISSUER` in both URLs (for example, `127.0.0.1` and `localhost` are different origins). Select **Get New Access Token**, sign in on the login page, then select **Use Token**. Postman sends `Authorization: Bearer ACCESS_TOKEN`; set **Use Token Type** to **Access token** rather than ID token. Request a new token after the access-token lifetime expires.

To use the token in GraphiQL, enable the query editor (`GRAPHQL_PLAYGROUND=true`, see the [README](../README.md)), open `/graphql`, and add the header in the **Headers** pane:

```json
{ "Authorization": "Bearer ACCESS_TOKEN" }
```

## Shared development

Use the existing [pause/drain/maintenance process](operations/google-cloud.md#pause-and-resume-releases) and [persistence activation](operations/neon.md). Authentication adds a separate opt-in Terraform gate, disabled by default. Apply reviewed secret-container preparation first. An engineer supplies at least 32 random characters directly to the individual `api-auth-secret` Secret Manager secret, recording only its numeric version. Terraform manages the container and runtime-only Secret Accessor grant, never its value; delivery has no direct access.

With releases paused and drained, apply reviewed migrations through the existing restricted migration path. Privately invoke `node backend/scripts/auth-setup.mjs` with the direct migration URL, selected auth secret, deliberate client ID/callback and matching API audience. This is an explicit operator action outside routine delivery. Do not load a local `.env` against shared targets. Runtime and the sign-in CLI never receive migration credentials.

Review Terraform inputs `enable_authentication = true`, `auth_secret_version`, `auth_issuer`, `api_audience` and `access_token_ttl_seconds`. Use the stable normal HTTPS service URL followed by `/auth` as issuer, including when requests reach a tagged candidate revision. Preserve the existing persistence gate and pinned database-secret versions. Apply, privately verify health/probe and authentication, then resume releases. Routine delivery retains its existing migration/seed checks and does not run Terraform or provision authentication.

Keep secrets out of plans, state, workflow variables, logs and issues. Changing `AUTH_SECRET` affects encrypted keys and sessions: an engineer must plan compatible re-encryption/key provisioning and retained rollback revisions. Merely changing its secret version is not a signing-key migration.

## Verification

Vitest HTTP tests use disposable PostgreSQL and real provider/token issuance. Follow [database verification](persistence.md#verification), including `TEST_ADMIN_DATABASE_URL`, then run `npm test -- test/authentication.spec.ts test/login-page.spec.ts test/update-own-names.spec.ts test/organizations.spec.ts`. Production image health checks remain independent of database and authentication secrets.
