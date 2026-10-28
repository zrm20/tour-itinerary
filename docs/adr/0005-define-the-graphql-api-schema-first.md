# Define the GraphQL API schema-first

Use GraphQL for the shared client API and define its contract in `.graphql` schema files, generating TypeScript resolver types from those definitions. Choose schema-first over generating the schema from TypeScript so the API contract can be reviewed independently of its implementation and deliberately designed for multiple clients. Keep the API schema separate from Prisma's database models rather than automatically exposing them.
