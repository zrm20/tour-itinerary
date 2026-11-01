# Tour Itinerary

This repository is for an itinerary app for touring teams. Tour admins build and manage itineraries; tour members use the app to read the schedule and the day's supporting details, such as location, hotel, and primary contacts. The schedule is central, and an itinerary item may be timed or all-day.

Organizations own named tours. Organization owners have authority across their organization. Tour admins can manage their assigned tours and invite read-only tour members; only organization owners can assign tour admins. A user's access is scoped to each tour, so the same person can have different roles on different tours.

The standalone application in `backend/` currently serves only `GET /health`. It runs natively without PostgreSQL or database configuration.

The agreed [backend architecture and stack](backend/backend.md) use TypeScript, Node.js LTS, NestJS, schema-first GraphQL with Apollo Server, Prisma, and PostgreSQL. Hosting is selected as Google Cloud Run for the API and Neon Free for PostgreSQL, with GitHub Actions deploying merges to `main` after checks pass. Vitest is the selected test runner.

Initial authentication uses Better Auth with its OAuth Provider and JWT plugins in an isolated identity-provider module. The client-agnostic API uses `@nestjs/authentication` to validate bearer access tokens, with application-owned user IDs and permissions independent of the provider. The initial account flows are for early development only; see [the authentication decision](docs/adr/0008-operate-authentication-in-an-isolated-oidc-module.md).

The architecture above records the agreed stack. GraphQL, persistence, and authentication are not implemented in the health-only application. GitHub Actions checks and verifies the production image; reviewed Terraform and keyless Cloud Run delivery are prepared for engineer bootstrap. No cloud provisioning or live deployment is implied by these files.

## Backend development

Use **Node.js 24.22.2 LTS**, pinned in [`.nvmrc`](.nvmrc) and enforced by the backend package's `engines` setting. It includes npm 11.19.1. Dependency versions and the resolved graph are committed in `backend/package.json` and `backend/package-lock.json`; use `npm ci` to reproduce them. Runtime and dependency upgrades require reviewed changes. CI and container tooling must use the same exact Node version when added.

From a clean checkout, using [nvm](https://github.com/nvm-sh/nvm):

```sh
nvm install
nvm use
cd backend
npm ci
# Optional: the application already has sensible local defaults.
cp .env.example .env
npm run start:dev
```

The API runs natively in watch mode and binds to `0.0.0.0` on the configured `PORT` (default `3000`). Source edits rebuild and restart it. Restart the command after editing `.env`. No Docker, database, cloud account, or secrets are needed.

In another terminal:

```sh
curl --fail-with-body --max-time 5 http://localhost:3000/health
```

The response is HTTP 200 with `{"status":"ok","commit":"local"}` by default. Health reports that the application can serve HTTP; it makes no database or external calls and returns only these two fields. `local` is the development/test marker, including for an uncommitted working tree. Production requires the full source Git SHA.

Run these commands from `backend/`:

| Command                        | Purpose                                                    |
| ------------------------------ | ---------------------------------------------------------- |
| `npm run start:dev`            | Compile and run natively, watching source changes          |
| `npm test`                     | Run the Vitest suite once                                  |
| `npm test -- test/app.spec.ts` | Run the real HTTP health integration tests                 |
| `npm run test:watch`           | Run Vitest in watch mode                                   |
| `npm run typecheck`            | Type-check source, tests, and Vitest configuration         |
| `npm run check`                | Check formatting, lint, types, tests, and production build |
| `npm run build`                | Compile production JavaScript to `dist/`                   |
| `npm run start:prod`           | Run the compiled `dist/main.js`                            |

`check` reports formatting/lint failures without modifying source and runs independently of Docker. Build outputs are gitignored. The HTTP integration tests boot Nest with the Express adapter and listen on an ephemeral loopback port; startup tests exercise the real application module's configuration validation.

### Environment configuration

The startup scripts load the optional, gitignored `backend/.env` using Node's native environment-file support. Existing environment variables take precedence. [`.env.example`](backend/.env.example) documents the settings without secrets. Tests isolate their settings and do not load this file.

| Variable     | Local default | Validation                                                                   |
| ------------ | ------------- | ---------------------------------------------------------------------------- |
| `NODE_ENV`   | `development` | `development`, `test`, or `production`                                       |
| `PORT`       | `3000`        | Decimal integer from `1` to `65535`                                          |
| `COMMIT_SHA` | `local`       | Full 40-character lowercase Git SHA; `local` allowed only outside production |

Empty or invalid settings fail at startup with the setting's name. `COMMIT_SHA` is required in production; the application does not invoke Git or contact a service to discover it. Configuration is typed and validated before listening. No database settings are consumed.

To verify the compiled application locally with a source SHA:

```sh
npm run build
NODE_ENV=production COMMIT_SHA="$(git rev-parse HEAD)" npm run start:prod
```

Then request `/health` and compare `commit` with `git rev-parse HEAD`. Builds require no environment file, database, or deployment settings.

### CI and production image

Pull requests and pushes to `main` install with `npm ci` on the exact pinned Node version and run the same `npm run check` used locally. They then build the `backend/Dockerfile` image for Cloud Run's `linux/amd64` architecture, start that image with a supplied `PORT`, and verify its real `/health` response without database or deployment credentials.

Image verification makes at most 15 requests. Each request has a 2-second timeout and failed attempts are separated by 2 seconds, bounding startup verification to about one minute including request and scheduling overhead. It rejects container startup failure, non-200 responses, invalid JSON, a status other than `ok`, or a commit different from the full workflow SHA.

On a successful push to `main`, CI saves the already-tested image as the `api-image-<full SHA>` workflow artifact for seven days. The delivery workflow downloads and loads that artifact, verifies its real health again, publishes it with the source-SHA tag, and deploys its immutable registry digest without rebuilding. It serializes candidate verification, promotion and automatic traffic recovery using GitHub OIDC, with a publish-only mode for first bootstrap.

To reproduce image verification locally from the repository root:

```sh
COMMIT_SHA="$(git rev-parse HEAD)"
docker buildx build --platform linux/amd64 --load \
  --build-arg "COMMIT_SHA=$COMMIT_SHA" \
  --tag "tour-itinerary-api:$COMMIT_SHA" backend
docker run --detach --name tour-itinerary-api-check \
  --publish 127.0.0.1:18080:8080 --env PORT=8080 \
  "tour-itinerary-api:$COMMIT_SHA"
node backend/scripts/verify-health.mjs \
  --url http://127.0.0.1:18080/health --commit "$COMMIT_SHA"
docker rm --force tour-itinerary-api-check
```

## Development model

AI agents write all application code. An engineer is expected to understand and review every change before it is merged. Agents are held to professional engineering standards, run relevant project checks, and add or update tests when a change calls for them. Task-specific issues can set how much implementation freedom an agent has.

## Documentation and planning

Repository documentation explains the project as it exists. Use this README for the current overview and, once available, setup and run instructions. Keep agreed domain terms in [GLOSSARY.md](GLOSSARY.md), consequential decisions in [`docs/adr/`](docs/adr/), and add architecture or feature explanations under `docs/` or next to related code as they become useful.

Track proposed work, future ideas, and roadmap items in [GitHub Issues](https://github.com/zrm20/tour-itinerary/issues). The project currently uses Issues without a separate Projects board or milestones. See [`docs/agents/issue-tracker.md`](docs/agents/issue-tracker.md) for the workflow.
