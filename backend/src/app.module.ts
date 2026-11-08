import { join } from 'node:path';
import { ApolloDriver, type ApolloDriverConfig } from '@nestjs/apollo';
import { GraphQLModule } from '@nestjs/graphql';
import { Module } from '@nestjs/common';
import { AuthenticationModule } from '@nestjs/authentication';
import { FixturePersistence } from './persistence/fixture-persistence';
import { PersistenceModule } from './persistence/persistence.module';
import { ProbeService } from './probe/probe.service';
import { ProbeResolver } from './probe/probe.resolver';
import { AuthConfig } from './authentication/auth.config';
import { ApiBearerProvider } from './authentication/api-bearer.provider';
import { UsersService } from './users/users.service';
import { QueryResolver } from './graphql/query.resolver';
import { MutationResolver } from './graphql/mutation.resolver';
import { IdentityProviderController } from './identity-provider/identity-provider.controller';
import { AppConfig } from './app-config';
import { AppConfigModule } from './app-config.module';
import { HealthController } from './health.controller';
import { OrganizationsModule } from './organizations/organizations.module';

const safeError = (code: unknown) => {
  if (code === 'INFRASTRUCTURE_PROBE_FAILED')
    return {
      code,
      message: 'Infrastructure probe unavailable.',
    } as const;
  if (code === 'UNAUTHENTICATED')
    return { code, message: 'Authentication required.' } as const;
  if (code === 'FORBIDDEN')
    return { code, message: 'Not authorized.' } as const;
  if (code === 'BAD_USER_INPUT')
    return { code, message: 'Invalid input.' } as const;
  return {
    code: 'GRAPHQL_REQUEST_FAILED' as const,
    message: 'GraphQL request failed.',
  };
};

@Module({
  imports: [
    AppConfigModule,
    PersistenceModule,
    OrganizationsModule,
    AuthenticationModule.forRoot(),
    GraphQLModule.forRootAsync<ApolloDriverConfig>({
      driver: ApolloDriver,
      imports: [AppConfigModule],
      inject: [AppConfig],
      useFactory: (config: AppConfig) => ({
        typePaths: [join(__dirname, '**/*.graphql')],
        playground: config.graphqlPlayground,
        includeStacktraceInErrorResponses: false,
        formatError: (error) => {
          const { code, message } = safeError(error.extensions?.code);
          return {
            message,
            ...(error.locations ? { locations: error.locations } : {}),
            ...(error.path ? { path: error.path } : {}),
            extensions: { code },
          };
        },
      }),
    }),
  ],
  controllers: [HealthController, IdentityProviderController],
  providers: [
    AuthConfig,
    UsersService,
    ApiBearerProvider,
    QueryResolver,
    MutationResolver,
    ProbeService,
    ProbeResolver,
    {
      provide: FixturePersistence,
      useFactory: () => new FixturePersistence(process.env.DATABASE_URL),
    },
  ],
})
export class AppModule {}
