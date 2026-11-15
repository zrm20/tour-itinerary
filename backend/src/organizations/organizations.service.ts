import { Injectable } from '@nestjs/common';
import { Database } from '../persistence/database';

export class InvalidOrganizationName extends Error {
  constructor(message = 'Invalid organization name.') {
    super(message);
    this.name = 'InvalidOrganizationName';
  }
}

export class InvalidOwnershipChange extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidOwnershipChange';
  }
}

export class OrganizationAccessDenied extends Error {
  constructor(message = 'Not authorized.') {
    super(message);
    this.name = 'OrganizationAccessDenied';
  }
}

function requireName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new InvalidOrganizationName();
  return trimmed;
}

@Injectable()
export class OrganizationsService {
  constructor(private readonly persistence: Database) {}

  async listOwners(actorId: string, organizationId: string) {
    await this.readOwned(actorId, organizationId);
    const owners = await this.persistence.database.organizationOwner.findMany({
      where: { organizationId },
      include: { user: true },
      orderBy: { userId: 'asc' },
    });
    return owners.map(({ user }) => ({
      id: user.id,
      displayName: user.preferredName ?? user.firstName,
    }));
  }

  async changeOwner(
    actorId: string,
    organizationId: string,
    userId: string,
    grant: boolean,
  ) {
    return this.persistence.write(async (transaction) => {
      // The shared mutation lock covers deletion and all ownership changes.
      // Read current authority only after acquiring it.
      const actor = await transaction.organizationOwner.findUnique({
        where: { organizationId_userId: { organizationId, userId: actorId } },
      });
      if (!actor) throw new OrganizationAccessDenied();
      if (grant) {
        const target = await transaction.applicationUser.findUnique({
          where: { id: userId },
          select: { id: true },
        });
        if (!target)
          throw new InvalidOwnershipChange(
            'Target must be a registered application user.',
          );
        await transaction.organizationOwner.upsert({
          where: { organizationId_userId: { organizationId, userId } },
          create: { organizationId, userId },
          update: {},
        });
      } else {
        const target = await transaction.organizationOwner.findUnique({
          where: { organizationId_userId: { organizationId, userId } },
        });
        if (
          target &&
          (await transaction.organizationOwner.count({
            where: { organizationId },
          })) === 1
        ) {
          throw new InvalidOwnershipChange(
            'An organization must retain at least one owner.',
          );
        }
        await transaction.organizationOwner.deleteMany({
          where: { organizationId, userId },
        });
      }
      return true;
    });
  }

  async create(userId: string, name: string) {
    const organizationName = requireName(name);
    return this.persistence.write(async (tx) => {
      await tx.applicationUser.findUniqueOrThrow({ where: { id: userId } });
      return tx.organization.create({
        data: { name: organizationName, owners: { create: { userId } } },
        select: { id: true, name: true },
      });
    });
  }

  async listOwned(userId: string) {
    return this.persistence.database.organization.findMany({
      where: { owners: { some: { userId } } },
      select: { id: true, name: true },
      orderBy: { id: 'asc' },
    });
  }

  async readOwned(userId: string, organizationId: string) {
    const organization = await this.persistence.database.organization.findFirst(
      {
        where: { id: organizationId, owners: { some: { userId } } },
        select: { id: true, name: true },
      },
    );
    if (!organization) throw new OrganizationAccessDenied();
    return organization;
  }

  async renameOwned(userId: string, organizationId: string, name: string) {
    const organizationName = requireName(name);
    return this.persistence.write(async (tx) => {
      const ownership = await tx.organizationOwner.findUnique({
        where: { organizationId_userId: { organizationId, userId } },
      });
      if (!ownership) throw new OrganizationAccessDenied();
      return tx.organization.update({
        where: { id: organizationId },
        data: { name: organizationName },
        select: { id: true, name: true },
      });
    });
  }

  async delete(userId: string, organizationId: string) {
    return this.persistence.write(async (tx) => {
      const ownership = await tx.organizationOwner.findUnique({
        where: { organizationId_userId: { organizationId, userId } },
      });
      if (!ownership) throw new OrganizationAccessDenied();
      await tx.organization.delete({ where: { id: organizationId } });
      return true;
    });
  }
}
