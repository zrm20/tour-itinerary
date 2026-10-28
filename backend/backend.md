# Backend architecture

The backend uses TypeScript with Node.js on an LTS release. It is being designed as a modular monolith with PostgreSQL as its primary database; application code has not been added yet.

Use NestJS with Apollo Server through Nest's official Apollo driver and the default Express HTTP adapter. Nest modules and injectable services organize the application; see [the framework decision](adr/0006-use-nestjs-with-apollo-server.md).

Use Prisma for database access and schema migrations.

Define the GraphQL API schema in `.graphql` files and generate TypeScript resolver types from it. Design the API contract independently of Prisma's database models; see [the schema-first decision](adr/0005-define-the-graphql-api-schema-first.md).

Business rules and authorization live outside GraphQL resolvers, with the API delegating to application logic. The backend serves the first web client and future native clients through a shared API.

Use OpenID Connect (OIDC), built on OAuth 2.0, for sign-in. Authorization is role-based, with organization-owner authority scoped to an organization and tour-admin and tour-member access scoped to individual tours as defined in [the tour-access decision](adr/0001-tour-access-is-scoped-per-tour.md). The authentication provider and whether it is managed or operated by the project have not been selected; provider selection is deferred, and any hosted identity service must fit within a free tier.

Host the API on Google Cloud Run with request-based billing and zero minimum instances, and PostgreSQL on Neon's Free plan. This targets inexpensive deployment for a non-revenue hobby project, accepting cold starts and free-plan limits; Google Cloud usage can still incur charges. These are hosting decisions, not an existing deployment. See [the hosting decision](adr/0007-host-the-api-on-cloud-run-and-postgresql-on-neon.md).

Use GitHub Actions for continuous integration and deployment. Pull requests run linting, type checks, tests, and a build, and agent-authored changes require engineer review before merge. Merges to `main` trigger the deployment workflow, which runs the checks on the merged commit and deploys it to Cloud Run only after they pass. The workflow has not been implemented yet.

Use Vitest with Nest's testing utilities. Emphasize integration tests exercising GraphQL operations, tour-access rules, and Prisma against an isolated PostgreSQL database, with focused unit tests for business logic where useful.

See the decisions on [backend-first client architecture](adr/0002-backend-first-client-architecture.md), [the modular monolith](adr/0003-start-with-a-modular-monolith.md), and [PostgreSQL](adr/0004-use-postgresql-for-primary-storage.md) for additional context.
