import { Injectable } from '@nestjs/common';
import { GraphQLError } from 'graphql';
import { Database } from '../persistence/database';

function requireName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new GraphQLError('Invalid organization name.', {
      extensions: { code: 'BAD_USER_INPUT' },
    });
  }
  return trimmed;
}

function forbidden(): never {
  throw new GraphQLError('Not authorized.', {
    extensions: { code: 'FORBIDDEN' },
  });
}

@Injectable()
export class OrganizationsService {
  constructor(private readonly persistence: Database) {}

  async create(userId: string, name: string) {
    const organizationName = requireName(name);
    // Nested create persists the organization and initial ownership together.
    return this.persistence.database.organization.create({
      data: {
        name: organizationName,
        owners: { create: { userId } },
      },
      select: { id: true, name: true },
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
    if (!organization) forbidden();
    return organization;
  }

  async renameOwned(userId: string, organizationId: string, name: string) {
    const organizationName = requireName(name);
    const ownership =
      await this.persistence.database.organizationOwner.findUnique({
        where: {
          organizationId_userId: { organizationId, userId },
        },
      });
    if (!ownership) forbidden();
    return this.persistence.database.organization.update({
      where: { id: organizationId },
      data: { name: organizationName },
      select: { id: true, name: true },
    });
  }
}
