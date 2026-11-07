import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import {
  AuthenticationRegistry,
  JwtBearerProvider,
  type JwtClaims,
} from '@nestjs/authentication';
import { AuthConfig } from './auth.config';
import { UsersService } from '../users/users.service';

type ApplicationUser = NonNullable<
  Awaited<ReturnType<UsersService['resolve']>>
>;
@Injectable()
export class ApiBearerProvider extends JwtBearerProvider<ApplicationUser> {
  constructor(
    private readonly config: AuthConfig,
    private readonly users: UsersService,
    registry: AuthenticationRegistry,
  ) {
    super({
      jwks: `${config.issuer}/jwks`,
      issuer: config.issuer,
      audience: config.audience,
      algorithms: ['RS256'],
      type: 'at+jwt',
      required: ['sub', 'exp', 'iat', 'jti', 'client_id'],
    });
    registry.registerProvider(this);
  }
  protected async validate(claims: JwtClaims) {
    if (!this.config.enabled || !claims.sub || claims.cnf) return null;
    try {
      return await this.users.resolve(this.config.issuer, claims.sub);
    } catch {
      throw new ServiceUnavailableException('Identity data is unavailable');
    }
  }
}
