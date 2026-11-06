import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';

export interface UserProfile {
  email: string;
  firstName: string;
  lastName: string;
  preferredName?: string | null;
}

@Injectable()
export class UsersService implements OnModuleDestroy {
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

  async provision(issuer: string, subject: string, profile: UserProfile) {
    // A single nested upsert is atomic. Email is deliberately neither a lookup
    // key nor unique in the application: only verified issuer + subject link users.
    try {
      return await this.database.providerIdentity.upsert({
        where: { issuer_subject: { issuer, subject } },
        update: {},
        create: { issuer, subject, user: { create: profile } },
        include: { user: true },
      });
    } catch (error) {
      // Concurrent first provisioning can race on the unique identity index.
      if (error instanceof Error && 'code' in error && error.code === 'P2002') {
        return this.database.providerIdentity.findUniqueOrThrow({
          where: { issuer_subject: { issuer, subject } },
          include: { user: true },
        });
      }
      throw error;
    }
  }

  async resolve(issuer: string, subject: string) {
    const identity = await this.database.providerIdentity.findUnique({
      where: { issuer_subject: { issuer, subject } },
      include: { user: true },
    });
    if (!identity) return null;
    const user = identity.user;
    return { ...user, displayName: user.preferredName ?? user.firstName };
  }

  async onModuleDestroy() {
    await this.database.$disconnect();
  }
}
