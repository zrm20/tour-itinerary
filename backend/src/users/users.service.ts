import { Injectable } from '@nestjs/common';
import { Database } from '../persistence/database';

export interface UserProfile {
  email: string;
  firstName: string;
  lastName: string;
  preferredName?: string | null;
}

@Injectable()
export class UsersService {
  constructor(private readonly persistence: Database) {}

  async provision(issuer: string, subject: string, profile: UserProfile) {
    // A single nested upsert is atomic. Email is deliberately neither a lookup
    // key nor unique in the application: only verified issuer + subject link users.
    try {
      return await this.persistence.database.providerIdentity.upsert({
        where: { issuer_subject: { issuer, subject } },
        update: {},
        create: { issuer, subject, user: { create: profile } },
        include: { user: true },
      });
    } catch (error) {
      // Concurrent first provisioning can race on the unique identity index.
      if (error instanceof Error && 'code' in error && error.code === 'P2002') {
        return this.persistence.database.providerIdentity.findUniqueOrThrow({
          where: { issuer_subject: { issuer, subject } },
          include: { user: true },
        });
      }
      throw error;
    }
  }

  async resolve(issuer: string, subject: string) {
    const identity =
      await this.persistence.database.providerIdentity.findUnique({
        where: { issuer_subject: { issuer, subject } },
        include: { user: true },
      });
    if (!identity) return null;
    const user = identity.user;
    return { ...user, displayName: user.preferredName ?? user.firstName };
  }
}
