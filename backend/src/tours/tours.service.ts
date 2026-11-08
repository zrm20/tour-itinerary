import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client';
import { Database } from '../persistence/database';

export class TourAccessDenied extends Error {}
export class InvalidTourName extends Error {}
export class InvalidTourUser extends Error {}

function accessible(userId: string, manage = false): Prisma.TourWhereInput {
  return {
    OR: [
      { organization: { owners: { some: { userId } } } },
      {
        access: {
          some: { userId, ...(manage ? { role: 'ADMIN' as const } : {}) },
        },
      },
    ],
  };
}

@Injectable()
export class ToursService {
  constructor(private readonly persistence: Database) {}

  async create(userId: string, organizationId: string, name: string) {
    const tourName = name.trim();
    if (!tourName) throw new InvalidTourName();
    const ownership =
      await this.persistence.database.organizationOwner.findUnique({
        where: { organizationId_userId: { organizationId, userId } },
      });
    if (!ownership) throw new TourAccessDenied();
    return this.persistence.database.tour.create({
      data: { organizationId, name: tourName },
    });
  }

  async rename(userId: string, id: string, name: string) {
    const tourName = name.trim();
    if (!tourName) throw new InvalidTourName();
    const result = await this.persistence.database.tour.updateMany({
      where: { id, ...accessible(userId, true) },
      data: { name: tourName },
    });
    if (!result.count) throw new TourAccessDenied();
    return this.read(userId, id);
  }

  async list(userId: string) {
    return this.persistence.database.tour.findMany({
      where: accessible(userId),
      orderBy: { id: 'asc' },
    });
  }

  async read(userId: string, id: string) {
    const tour = await this.persistence.database.tour.findFirst({
      where: { id, ...accessible(userId) },
    });
    if (!tour) throw new TourAccessDenied();
    return tour;
  }

  async listAccess(userId: string, tourId: string) {
    const tour = await this.persistence.database.tour.findFirst({
      where: { id: tourId, ...accessible(userId, true) },
    });
    if (!tour) throw new TourAccessDenied();
    return this.persistence.database.tourAccess.findMany({
      where: { tourId },
      orderBy: { userId: 'asc' },
    });
  }

  private async asOwner<T>(
    userId: string,
    tourId: string,
    action: (tx: Prisma.TransactionClient) => Promise<T>,
  ) {
    return this.persistence.database.$transaction(async (tx) => {
      const tour = await tx.tour.findUnique({ where: { id: tourId } });
      if (!tour) throw new TourAccessDenied();
      // Serialize with ownership changes, then recheck current owner authority.
      await tx.$queryRaw`SELECT id FROM organization WHERE id = ${tour.organizationId} FOR UPDATE`;
      const owner = await tx.organizationOwner.findUnique({
        where: {
          organizationId_userId: {
            organizationId: tour.organizationId,
            userId,
          },
        },
      });
      if (!owner) throw new TourAccessDenied();
      return action(tx);
    });
  }

  async grantAdmin(actorId: string, tourId: string, userId: string) {
    return this.asOwner(actorId, tourId, async (tx) => {
      if (!(await tx.applicationUser.findUnique({ where: { id: userId } })))
        throw new InvalidTourUser();
      return tx.tourAccess.upsert({
        where: { tourId_userId: { tourId, userId } },
        create: { tourId, userId, role: 'ADMIN' },
        update: { role: 'ADMIN' },
      });
    });
  }

  async removeAdmin(actorId: string, tourId: string, userId: string) {
    return this.asOwner(actorId, tourId, async (tx) => {
      await tx.tourAccess.deleteMany({ where: { tourId, userId } });
      return true;
    });
  }
  private async asMemberManager<T>(
    actorId: string,
    tourId: string,
    userId: string,
    action: (tx: Prisma.TransactionClient) => Promise<T>,
  ) {
    return this.persistence.database.$transaction(async (tx) => {
      const tour = await tx.tour.findUnique({ where: { id: tourId } });
      if (!tour) throw new TourAccessDenied();
      // All access changes share the ownership lock. Recheck actor and target
      // after taking it so concurrent promotions cannot be undone by an admin.
      await tx.$queryRaw`SELECT id FROM organization WHERE id = ${tour.organizationId} FOR UPDATE`;
      const owner = await tx.organizationOwner.findUnique({
        where: {
          organizationId_userId: {
            organizationId: tour.organizationId,
            userId: actorId,
          },
        },
      });
      if (!owner) {
        const actor = await tx.tourAccess.findUnique({
          where: { tourId_userId: { tourId, userId: actorId } },
        });
        const target = await tx.tourAccess.findUnique({
          where: { tourId_userId: { tourId, userId } },
        });
        if (actor?.role !== 'ADMIN' || target?.role === 'ADMIN')
          throw new TourAccessDenied();
      }
      return action(tx);
    });
  }

  async grantMember(actorId: string, tourId: string, userId: string) {
    return this.asMemberManager(actorId, tourId, userId, async (tx) => {
      if (!(await tx.applicationUser.findUnique({ where: { id: userId } })))
        throw new InvalidTourUser();
      return tx.tourAccess.upsert({
        where: { tourId_userId: { tourId, userId } },
        create: { tourId, userId, role: 'MEMBER' },
        update: { role: 'MEMBER' },
      });
    });
  }

  async removeMember(actorId: string, tourId: string, userId: string) {
    return this.asMemberManager(actorId, tourId, userId, async (tx) => {
      await tx.tourAccess.deleteMany({ where: { tourId, userId } });
      return true;
    });
  }
}
