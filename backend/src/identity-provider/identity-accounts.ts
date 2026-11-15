import { Injectable } from '@nestjs/common';
import { AuthConfig } from '../authentication/auth.config';
import type { Prisma } from '../generated/prisma/client';

@Injectable()
export class IdentityAccounts {
  constructor(private readonly config: AuthConfig) {}

  async requireProvisionable(
    tx: Prisma.TransactionClient,
    issuer: string,
    subject: string,
  ) {
    if (issuer === this.config.issuer) {
      // Session hooks may carry a previously read user. Recheck persistence
      // under the mutation lock before creating an application mapping.
      await tx.user.findUniqueOrThrow({ where: { id: subject } });
    }
  }

  async deleteLinked(
    tx: Prisma.TransactionClient,
    identities: { issuer: string; subject: string }[],
  ) {
    const subjects = identities
      .filter(({ issuer }) => issuer === this.config.issuer)
      .map(({ subject }) => subject);
    if (!subjects.length) return;

    const sessions = await tx.session.findMany({
      where: { userId: { in: subjects } },
      select: { id: true },
    });
    const userIds = new Set(subjects);
    const sessionIds = new Set(sessions.map(({ id }) => id));
    // Better Auth OAuth Provider 1.7.18 stores outstanding authorization codes
    // as JSON verification values (userId/sessionId), without foreign keys.
    // Other verification values are opaque and must remain untouched.
    const verifications = await tx.verification.findMany({
      select: { id: true, value: true },
    });
    const ids = verifications
      .filter(({ value }) => {
        let data: unknown;
        try {
          data = JSON.parse(value);
        } catch {
          return false;
        }
        if (!data || typeof data !== 'object') return false;
        return (
          ('userId' in data &&
            typeof data.userId === 'string' &&
            userIds.has(data.userId)) ||
          ('sessionId' in data &&
            typeof data.sessionId === 'string' &&
            sessionIds.has(data.sessionId))
        );
      })
      .map(({ id }) => id);
    await tx.verification.deleteMany({ where: { id: { in: ids } } });
    // Clients/resources and signing keys are shared infrastructure. Detach a
    // client administrator rather than cascading through other users' grants.
    await tx.oauthClient.updateMany({
      where: { userId: { in: subjects } },
      data: { userId: null },
    });
    // FK cascades remove credentials, sessions, consents and stored tokens.
    await tx.user.deleteMany({ where: { id: { in: subjects } } });
  }
}
