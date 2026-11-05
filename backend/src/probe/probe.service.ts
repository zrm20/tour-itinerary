import { Inject, Injectable, Logger } from '@nestjs/common';
import { FixturePersistence } from '../persistence/fixture-persistence';

export class ProbeUnavailable extends Error {
  constructor() {
    super('Infrastructure probe unavailable.');
  }
}

@Injectable()
export class ProbeService {
  private readonly logger = new Logger(ProbeService.name);

  constructor(
    @Inject(FixturePersistence)
    private readonly persistence: FixturePersistence,
  ) {}

  async execute(): Promise<{ message: string }> {
    try {
      const fixture = await this.persistence.read();
      if (fixture) return fixture;
      this.logger.warn('Infrastructure probe fixture missing');
    } catch {
      // Never serialize Prisma/driver errors: these may contain credentials/SQL.
      this.logger.warn('Infrastructure probe database read failed');
    }
    throw new ProbeUnavailable();
  }
}
