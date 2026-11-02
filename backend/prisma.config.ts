import { defineConfig } from 'prisma/config';

// Generation is DB-free. Commands that connect validate their inputs separately.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: {
    url:
      process.env.MIGRATION_DATABASE_URL ??
      'postgresql://unused:unused@127.0.0.1:5432/unused',
    shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL,
  },
});
