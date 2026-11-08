import { Injectable } from '@nestjs/common';
import { Database } from '../persistence/database';

export interface UserProfile {
  email: string;
  firstName: string;
  lastName: string;
  preferredName?: string | null;
}

export interface OwnNamesUpdate {
  firstName: string;
  lastName: string;
  preferredName?: string | null;
}

export class InvalidOwnNames extends Error {
  constructor(message = 'Name fields are invalid') {
    super(message);
    this.name = 'InvalidOwnNames';
  }
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
    return this.withDisplayName(identity.user);
  }

  async updateOwnNames(userId: string, input: OwnNamesUpdate) {
    const firstName = requireName(input.firstName, 'firstName');
    const lastName = requireName(input.lastName, 'lastName');
    const preferredName =
      input.preferredName == null
        ? null
        : requireName(input.preferredName, 'preferredName');
    const user = await this.persistence.database.applicationUser.update({
      where: { id: userId },
      data: { firstName, lastName, preferredName },
    });
    return this.withDisplayName(user);
  }

  private withDisplayName<
    T extends { firstName: string; preferredName: string | null },
  >(user: T) {
    return { ...user, displayName: user.preferredName ?? user.firstName };
  }
}

function requireName(value: string, field: string) {
  const trimmed = value.trim();
  if (!trimmed) throw new InvalidOwnNames(`${field} is required`);
  return trimmed;
}
