import { Injectable } from '@nestjs/common';
import { Database } from '../persistence/database';
import { IdentityAccounts } from '../identity-provider/identity-accounts';

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

export class InvalidUserDeletion extends Error {}

export class InvalidOwnNames extends Error {
  constructor(message = 'Name fields are invalid') {
    super(message);
    this.name = 'InvalidOwnNames';
  }
}

@Injectable()
export class UsersService {
  constructor(
    private readonly persistence: Database,
    private readonly accounts: IdentityAccounts,
  ) {}

  async provision(issuer: string, subject: string, profile: UserProfile) {
    return this.persistence.write(async (tx) => {
      await this.accounts.requireProvisionable(tx, issuer, subject);
      // Email is neither a lookup key nor unique in the application. The
      // mutation lock also serializes concurrent first provisioning.
      return tx.providerIdentity.upsert({
        where: { issuer_subject: { issuer, subject } },
        update: {},
        create: { issuer, subject, user: { create: profile } },
        include: { user: true },
      });
    });
  }

  async deleteOwn(userId: string) {
    return this.persistence.write(async (tx) => {
      const user = await tx.applicationUser.findUniqueOrThrow({
        where: { id: userId },
        include: { identities: true, ownerships: true },
      });
      for (const { organizationId } of user.ownerships) {
        if (
          (await tx.organizationOwner.count({ where: { organizationId } })) ===
          1
        ) {
          throw new InvalidUserDeletion(
            'An organization must retain at least one owner.',
          );
        }
      }
      await this.accounts.deleteLinked(tx, user.identities);
      await tx.applicationUser.delete({ where: { id: userId } });
      return true;
    });
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
    const user = await this.persistence.write((tx) =>
      tx.applicationUser.update({
        where: { id: userId },
        data: { firstName, lastName, preferredName },
      }),
    );
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
