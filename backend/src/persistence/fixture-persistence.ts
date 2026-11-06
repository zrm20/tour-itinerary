import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';

/** A lazy connection: constructing this provider never contacts PostgreSQL. */
export class FixturePersistence {
  private readonly client: PrismaClient | undefined;

  constructor(connectionString?: string) {
    if (!connectionString) return;
    this.client = new PrismaClient({
      adapter: new PrismaPg({
        connectionString,
        max: 2,
        connectionTimeoutMillis: 5000,
        idleTimeoutMillis: 10000,
        statement_timeout: 5000,
        query_timeout: 6000,
      }),
      log: [],
    });
  }

  async read(): Promise<{ message: string } | null> {
    if (!this.client) throw new Error('Database unavailable');
    return this.client.infrastructureFixture.findUnique({
      where: { key: 'infrastructure-probe' },
      select: { message: true },
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.close();
  }

  async close(): Promise<void> {
    await this.client?.$disconnect();
  }
}
