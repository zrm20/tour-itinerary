import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';

@Injectable()
export class Database implements OnModuleDestroy {
  // Constructing Prisma is lazy: health/startup never connect or seed.
  readonly database = new PrismaClient({
    adapter: new PrismaPg({
      connectionString:
        process.env.DATABASE_URL ??
        'postgresql://disabled:disabled@127.0.0.1:1/disabled',
      max: 5,
      connectionTimeoutMillis: 5000,
      statement_timeout: 5000,
      query_timeout: 6000,
    }),
    log: [],
  });

  async onModuleDestroy() {
    await this.database.$disconnect();
  }
}
