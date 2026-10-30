# Backend architecture

The backend uses TypeScript with Node.js on an LTS release. The implemented application is a standalone NestJS health-only HTTP API using the default Express adapter, typed startup configuration, and Vitest integration tests. It starts without a database. See the [backend development instructions](../README.md#backend-development) for the pinned toolchain, configuration, checks, and native watch/build/run commands.

The agreed architecture is a modular monolith with PostgreSQL as its primary database. The decisions below describe that architecture; GraphQL, persistence, authentication, and hosting are not implemented in the health-only scaffold.

Use NestJS with Apollo Server through Nest's official Apollo driver and the default Express HTTP adapter. Nest modules and injectable services organize the application; see [the framework decision](../docs/adr/0006-use-nestjs-with-apollo-server.md).

Use Prisma for database access and schema migrations.

Define the GraphQL API schema in `.graphql` files and generate TypeScript resolver types from it. Design the API contract independently of Prisma's database models; see [the schema-first decision](../docs/adr/0005-define-the-graphql-api-schema-first.md).

Business rules and authorization live outside GraphQL resolvers, with the API delegating to application logic. The backend serves the first web client and future native clients through a shared API.

Use OpenID Connect (OIDC), built on OAuth 2.0, for sign-in. Initially operate authentication in a dedicated NestJS identity-provider module using Better Auth with its OAuth Provider and JWT plugins, keeping it separate from business services and retaining a standard protocol boundary for later replacement by a managed identity provider. Use Better Auth's email/password authentication and Prisma adapter, with its types and persistence models contained within the identity-provider module; see [the authentication decision](../docs/adr/0008-operate-authentication-in-an-isolated-oidc-module.md). Authorization is role-based, with organization-owner authority scoped to an organization and tour-admin and tour-member access scoped to individual tours as defined in [the tour-access decision](../docs/adr/0001-tour-access-is-scoped-per-tour.md).

The application owns a permanent user ID independent of the authentication provider. Organization ownership and tour-access assignments reference that ID, with the authentication integration mapping a provider login identity to the application user; see [the user-identity decision](../docs/adr/0009-keep-application-user-identity-independent-of-authentication.md).

Authentication persistence shares the existing PostgreSQL database, with dedicated tables owned exclusively by the authentication module. Other modules reference application user IDs and must not query credential or authentication-session tables directly.

Clients use redirect-based OIDC sign-in through Authorization Code with PKCE. The authentication module owns the login page, served within the NestJS deployment; password login is not exposed as a custom GraphQL operation.

The application API remains client agnostic and does not act as a browser-session backend or BFF. Cookie sessions and browser-specific token handling belong to a separate client-owned server framework or thin BFF if a web client chooses that architecture. Hosting the initial authentication server alongside the API does not give the application API responsibility for client-specific sessions.

The API acts as an OAuth resource server, accepting short-lived, asymmetrically signed JWT access tokens. Use `@nestjs/authentication` for bearer-token validation, endpoint protection, and resolving the application user, configured with the trusted issuer, API audience, and public keys/JWKS independently of Better Auth. Validate token signatures, issuer, audience, and expiry; organization and tour permissions come from application data. Token issuance stays in the identity-provider module, and the API does not create browser cookie sessions. Revoking a login session alone does not immediately invalidate an already-issued access token. See [the access-token decision](../docs/adr/0010-validate-jwt-access-tokens-at-the-api-boundary.md).

The initial authentication scope covers user creation and email/password login for early development only. Email is a sign-in attribute, not the user's permanent application identity or a foreign key for organization ownership or tour access. Self-service password changes, recovery, and advanced abuse controls are deferred; revisit the authentication design before public release. Endpoint protection, application authorization, secure password storage, correct token validation, and appropriate handling of keys and secrets are required from the start.

Development accounts may sign in immediately without email verification. Treat email addresses as unverified, and never merge accounts or grant an existing user's access solely because an email address matches.

Host the API on Google Cloud Run with request-based billing and zero minimum instances, and PostgreSQL on Neon's Free plan. This targets inexpensive deployment for a non-revenue hobby project, accepting cold starts and free-plan limits; Google Cloud usage can still incur charges. These are hosting decisions, not an existing deployment. See [the hosting decision](../docs/adr/0007-host-the-api-on-cloud-run-and-postgresql-on-neon.md).

Use GitHub Actions for continuous integration and deployment. Pull requests and merges to `main` run the shared checks and verify the production Linux image by starting it and requesting `/health`; agent-authored changes require engineer review before merge. Successful `main` checks retain the exact tested image as a short-lived workflow artifact for the delivery workflow to publish without rebuilding. Cloud Run publication and rollout are not implemented yet.

Use Vitest with Nest's testing utilities. Emphasize integration tests exercising GraphQL operations, tour-access rules, and Prisma against an isolated PostgreSQL database, with focused unit tests for business logic where useful.

See the decisions on [backend-first client architecture](../docs/adr/0002-backend-first-client-architecture.md), [the modular monolith](../docs/adr/0003-start-with-a-modular-monolith.md), and [PostgreSQL](../docs/adr/0004-use-postgresql-for-primary-storage.md) for additional context.
