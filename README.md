# Tour Itinerary

This repository is for an itinerary app for touring teams. Tour admins build and manage itineraries; tour members use the app to read the schedule and the day's supporting details, such as location, hotel, and primary contacts. The schedule is central, and an itinerary item may be timed or all-day.

Organizations own named tours. Organization owners have authority across their organization. Tour admins can manage their assigned tours and invite read-only tour members; only organization owners can assign tour admins. A user's access is scoped to each tour, so the same person can have different roles on different tours.

The repository is currently at the product-design stage; application code has not been added yet.

The agreed [backend architecture and stack](docs/backend.md) use TypeScript, Node.js LTS, NestJS, schema-first GraphQL with Apollo Server, Prisma, and PostgreSQL. Hosting is selected as Google Cloud Run for the API and Neon Free for PostgreSQL, with GitHub Actions deploying merges to `main` after checks pass. Vitest is the selected test runner.

## Development model

AI agents write all application code. An engineer is expected to understand and review every change before it is merged. Agents are held to professional engineering standards, run relevant project checks, and add or update tests when a change calls for them. Task-specific issues can set how much implementation freedom an agent has.

## Documentation and planning

Repository documentation explains the project as it exists. Use this README for the current overview and, once available, setup and run instructions. Keep agreed domain terms in [GLOSSARY.md](GLOSSARY.md), consequential decisions in [`docs/adr/`](docs/adr/), and add architecture or feature explanations under `docs/` or next to related code as they become useful.

Track proposed work, future ideas, and roadmap items in [GitHub Issues](https://github.com/zrm20/tour-itinerary/issues). The project currently uses Issues without a separate Projects board or milestones. See [`docs/agents/issue-tracker.md`](docs/agents/issue-tracker.md) for the workflow.
