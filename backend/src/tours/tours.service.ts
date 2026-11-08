import { Injectable } from '@nestjs/common';
import { Database } from '../persistence/database';

export class TourAccessDenied extends Error {}
export class InvalidTourName extends Error {}

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
      where: { id, organization: { owners: { some: { userId } } } },
      data: { name: tourName },
    });
    if (!result.count) throw new TourAccessDenied();
    return this.read(userId, id);
  }

  async list(userId: string) {
    return this.persistence.database.tour.findMany({
      where: { organization: { owners: { some: { userId } } } },
      orderBy: { id: 'asc' },
    });
  }

  async read(userId: string, id: string) {
    const tour = await this.persistence.database.tour.findFirst({
      where: { id, organization: { owners: { some: { userId } } } },
    });
    if (!tour) throw new TourAccessDenied();
    return tour;
  }
}
