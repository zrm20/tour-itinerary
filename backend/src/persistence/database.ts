import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, type Prisma } from '../generated/prisma/client';

// Shared by all instances connected to this database. Serialize domain writes
// and provider requests so deletion cannot race provisioning or authorization.
const mutationLock = 34001;

@Injectable()
export class Database implements OnModuleDestroy {
  private readonly mutationScope = new AsyncLocalStorage<boolean>();
  private readonly coordination = new pg.Pool({
    connectionString:
      process.env.DATABASE_URL ??
      'postgresql://disabled:disabled@127.0.0.1:1/disabled',
    max: 1,
    connectionTimeoutMillis: 5000,
    statement_timeout: 5000,
    query_timeout: 6000,
  });
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

  async write<T>(action: (tx: Prisma.TransactionClient) => Promise<T>) {
    return this.withMutationLock(() => this.database.$transaction(action));
  }

  async withMutationLock<T>(action: () => Promise<T>) {
    if (this.mutationScope.getStore()) return action();
    // A separate connection holds only the lock. The provider retains its own
    // transaction semantics, including retry-safe provisioning after sign-up
    // fails. All writers acquire the lock before taking query-pool connections
    // so waiting mutations cannot starve a provider operation holding the lock.
    const connection = await this.coordination.connect();
    try {
      await connection.query('BEGIN');
      await connection.query('SELECT pg_advisory_xact_lock($1)', [
        mutationLock,
      ]);
      return await this.mutationScope.run(true, action);
    } finally {
      try {
        await connection.query('ROLLBACK');
        connection.release();
      } catch {
        connection.release(true);
      }
    }
  }

  async onModuleDestroy() {
    await this.database.$disconnect();
    await this.coordination.end();
  }
}
