import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';

/** A lazy connection: constructing this provider never contacts PostgreSQL. */
export class FixturePersistence {
  private readonly client: PrismaClient;

  constructor(connectionString: string) {
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
    return this.client.infrastructureFixture.findUnique({
      where: { key: 'infrastructure-probe' },
      select: { message: true },
    });
  }

  async close(): Promise<void> {
    await this.client.$disconnect();
  }
}
