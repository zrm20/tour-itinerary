import { Injectable } from '@nestjs/common';

@Injectable()
export class AuthConfig {
  readonly enabled = process.env.AUTH_ISSUER !== undefined;
  readonly issuer = process.env.AUTH_ISSUER ?? 'http://127.0.0.1:3000/auth';
  readonly audience = process.env.API_AUDIENCE ?? 'urn:tour-itinerary:api';
  readonly secret = process.env.AUTH_SECRET;
  readonly lifetime: number;
  constructor() {
    const value = process.env.ACCESS_TOKEN_TTL_SECONDS ?? '1800';
    this.lifetime = Number(value);
    if (
      !/^[1-9]\d*$/.test(value) ||
      !Number.isSafeInteger(this.lifetime) ||
      this.lifetime > 86400
    )
      throw new Error(
        'ACCESS_TOKEN_TTL_SECONDS must be an integer from 1 to 86400',
      );
    if (!this.enabled) return;
    const issuer = new URL(this.issuer);
    if (
      issuer.pathname !== '/auth' ||
      issuer.search ||
      issuer.hash ||
      issuer.username ||
      issuer.password ||
      !(
        issuer.protocol === 'https:' ||
        (issuer.protocol === 'http:' &&
          ['localhost', '127.0.0.1', '[::1]'].includes(issuer.hostname))
      )
    )
      throw new Error(
        'AUTH_ISSUER must be an HTTPS URL ending in /auth (HTTP loopback allowed)',
      );
    if (!this.secret || this.secret.length < 32)
      throw new Error('AUTH_SECRET must contain at least 32 characters');
    if (!process.env.DATABASE_URL)
      throw new Error(
        'DATABASE_URL is required when AUTH_ISSUER is configured',
      );
    if (!this.audience || new URL(this.audience).hash)
      throw new Error(
        'API_AUDIENCE must be an absolute URI without a fragment',
      );
  }
}
