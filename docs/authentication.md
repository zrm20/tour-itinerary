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

Authenticated users can create named organizations, list and read organizations they own, and rename an owned organization through schema-first GraphQL. Creation atomically records the permanent application user as the first organization owner. Organization names are not unique. Ownership is a user-to-organization association keyed by application user ID, never email or provider session records. Unauthenticated callers and nonowners cannot read or rename unrelated organizations. Owners can list owners with `organizationOwners(organizationId: ID!)`, grant ownership with `grantOrganizationOwner(organizationId: ID!, userId: ID!)`, and relinquish or remove it with `removeOrganizationOwner(organizationId: ID!, userId: ID!)`. Mutations return `true` on success; repeated grants and removing an absent association are idempotent. Targets for grants must already be registered application user IDs; email addresses and invitations are not supported. Owner lists expose permanent IDs and profile display names. Every owner has equal authority, including over ownership. Nonowners cannot inspect owner lists or manage ownership.

Ownership mutations lock the organization's database row and recheck the caller's current ownership inside the transaction. A removal is rejected with `BAD_USER_INPUT` if it would remove the final owner, including concurrent attempts. Grants/removals take effect on the next organization request with the same valid bearer token. Removing ownership does not delete the user or change any separately assigned tour role.

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

## GraphiQL sign-in

Set `GRAPHQL_PLAYGROUND=true` and `GRAPHQL_OIDC_CLIENT_ID=tour-itinerary-graphiql` in `backend/.env`, alongside the authentication settings above. Choose a client ID distinct from `OIDC_CLIENT_ID`. Run `npm run auth:setup` explicitly, then restart the backend. Setup adds a **public web client** with required S256 PKCE and end-session support while preserving the native CLI/Postman client and existing signing keys. No startup, editor request, health check or ordinary read provisions database state.

The browser callback is exactly the origin of `AUTH_ISSUER` followed by `/graphql/auth/callback`, for example `http://127.0.0.1:3000/graphql/auth/callback`. The registered logout return destination is that origin followed by `/graphql`. HTTP is allowed only on loopback; shared development uses HTTPS. Open `/graphql` on the exact issuer origin (including host and port); `localhost`, `127.0.0.1`, tagged revision hosts and other aliases are different origins.

Choose **Sign in**, enter an existing account's email and password on `/auth/login`, and return to GraphiQL. Run `currentUser` or another permitted operation: the fetcher automatically sends the API access token as a bearer header. The editor validates callback state and expiry, uses PKCE for code exchange, and validates the ID token's signature, issuer, audience, expiry and nonce before retaining it for logout. Access tokens are independently validated for the API audience and token kind; application permissions are unchanged.

**Sign out / switch account** immediately clears the editor's access token and uses the existing RP-initiated logout endpoint to end that provider session. Successful logout permits sign-in as another account. Failed logout leaves the editor signed out, reports failure, and retains only the ID-token logout handle so the tester can retry. Other provider sessions remain active. Already-issued JWT access tokens retain their original expiry semantics. Logout uses a back-channel POST with the ID-token hint in the body; it does not navigate to the registered logout return URL.

The editor keeps its access token, ID-token logout handle and pending PKCE/state/nonce in **tab-scoped `sessionStorage`**, separate from GraphiQL's query history. Reloading retains the editor session; closing the tab clears its storage but does not itself log out of the provider. Duplicating a tab may copy that tab's session, so use a new independent sign-in for independent-session testing. Query/variable history follows GraphiQL's existing browser storage behavior. The Headers pane and header persistence are disabled; tokens are attached only by the fetcher and never saved in GraphiQL headers/history, placed in URLs, or logged. Callback response parameters are removed from the address bar before external editor assets load. Browser session storage must be enabled; otherwise public queries remain available with a configuration message.

Expired or rejected access tokens stop being attached, and the editor prompts the tester to sign out and sign in again. There is no automatic refresh. `FORBIDDEN` means the account lacks permission and does not expire the editor session. Failed, cancelled, unsolicited, replayed or expired authorization callbacks show a generic retry message without reflecting provider errors, credentials or tokens. Pending sign-ins expire after ten minutes. With authentication or the browser client unconfigured, the editor remains usable for public operations and hides sign-in. With `GRAPHQL_PLAYGROUND=false`, the editor and all editor-authentication routes are unavailable, preserving the existing GraphQL API and database-independent health/startup behavior.

## Shared development

Use the existing [pause/drain/maintenance process](operations/google-cloud.md#pause-and-resume-releases) and [persistence activation](operations/neon.md). Authentication adds a separate opt-in Terraform gate, disabled by default. Apply reviewed secret-container preparation first. An engineer supplies at least 32 random characters directly to the individual `api-auth-secret` Secret Manager secret, recording only its numeric version. Terraform manages the container and runtime-only Secret Accessor grant, never its value; delivery has no direct access.

With releases paused and drained, apply reviewed migrations through the existing restricted migration path. Privately invoke `node backend/scripts/auth-setup.mjs` with the direct migration URL, selected auth secret, deliberate client ID/callback and matching API audience. This is an explicit operator action outside routine delivery. Do not load a local `.env` against shared targets. Runtime and the sign-in CLI never receive migration credentials.

Review Terraform inputs `enable_authentication = true`, `auth_secret_version`, `auth_issuer`, `api_audience` and `access_token_ttl_seconds`. Use the stable normal HTTPS service URL followed by `/auth` as issuer, including when requests reach a tagged candidate revision. Preserve the existing persistence gate and pinned database-secret versions. Apply, privately verify health/probe and authentication, then resume releases. Routine delivery retains its existing migration/seed checks and does not run Terraform or provision authentication.

To enable editor sign-in in shared development, while releases are paused and drained, an engineer explicitly runs the same setup with `GRAPHQL_OIDC_CLIENT_ID` and the stable HTTPS `AUTH_ISSUER` as well as the existing native client and resource settings. This registers the exact HTTPS `/graphql/auth/callback` and `/graphql` logout return destination. Set the matching reviewed Terraform inputs `graphql_playground = true` and `graphql_oidc_client_id` to that public web client ID, plan/review/apply through the existing maintenance process, verify sign-in on the normal service origin, then resume releases. Omit the client ID for a public-query-only editor; leave `graphql_playground = false` to disable the editor and its authentication routes. No shared provisioning or deployment is performed by routine delivery.

Keep secrets out of plans, state, workflow variables, logs and issues. Changing `AUTH_SECRET` affects encrypted keys and sessions: an engineer must plan compatible re-encryption/key provisioning and retained rollback revisions. Merely changing its secret version is not a signing-key migration.

## Verification

Vitest HTTP tests use disposable PostgreSQL and real provider/token issuance. Follow [database verification](persistence.md#verification), including `TEST_ADMIN_DATABASE_URL`, then run `npm test -- test/authentication.spec.ts test/login-page.spec.ts test/graphiql.spec.ts test/update-own-names.spec.ts test/organizations.spec.ts test/tours.spec.ts`. Production image health checks remain independent of database and authentication secrets.

## Tours owned by organizations

Organization owners can create tours with `createTour(organizationId, name)`,
read one with `tour(id)`, list accessible tours with `myTours`, and rename one
with `renameTour(id, name)`. A `Tour` returns `id`, `name`, and `organizationId`.
Names are trimmed and must contain a non-whitespace character; names can repeat
within an organization. Tours require no dates or administrator assignment.
Every operation checks current organization ownership from application data,
including direct-ID reads and mutations. Unknown and inaccessible targets both
return `FORBIDDEN`. Ownership grants authority over every tour in that organization.

## Assigned tour admins

An organization owner grants admin access to a registered application user with
`grantTourAdmin(tourId, userId)` and removes it with
`removeTourAdmin(tourId, userId)`. Repeated grants preserve one assignment per
user/tour; repeated removals succeed. Unknown grant targets return `BAD_USER_INPUT`.
Owners and assigned admins can list assignments with `tourAccess(tourId)`, which
returns `tourId`, `userId`, and `role` (`ADMIN`). Only owners can change admin
assignments, including an admin's own assignment.

Assigned admins can read and rename that tour, and `myTours` combines their
assigned tours with tours available through ownership without duplicates. The
assignment grants no sibling-tour or organization authority. Owners retain full
tour authority without an explicit assignment; removing their assignment leaves
ownership intact. Assignments reference permanent application user IDs and remain
independent of ownership. Revocation changes the next request with the same valid
access token. Admin-assignment changes serialize on the organization row with
ownership changes and recheck the actor's authority after obtaining the lock.

## Read-only tour members

Owners and assigned tour admins grant registered users read-only access with
`grantTourMember(tourId, userId)` and remove assignments with
`removeTourMember(tourId, userId)`. `tourAccess` returns `ADMIN` or `MEMBER`.
Members can read their tour and see it in `myTours`, but cannot rename it, list
assignments, manage access, or manage the organization. Access never extends to
sibling tours. A user may administer one tour and be a member of another.

Owners can replace either assigned role by granting the other role. There is
one assignment per user/tour. Member-management operations let owners remove
any assignment; admins can only grant/remove members and cannot overwrite or
remove a current admin, including themselves. Admin-specific mutations remain
owner-only. Repeated grants/removals are safe. Unknown grant targets return
`BAD_USER_INPUT`; unauthorized or unknown tours return `FORBIDDEN`.

```graphql
mutation {
  grantTourMember(tourId: "tour-id", userId: "permanent-application-user-id") {
    userId
    role
  }
}
```

All access mutations serialize with ownership changes on the organization row,
then check current actor authority and the target's current assigned role.
Role replacements and removals affect the next API request using the same valid
bearer token. Ownership grants/removals preserve assigned roles: after ownership
removal, an assigned admin retains admin authority, an assigned member retains
read-only access, and an unassigned former owner loses tour access. Profile name
changes preserve both ownership and tour assignments.
