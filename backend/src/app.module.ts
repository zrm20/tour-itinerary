import { Database } from './persistence/database';
import { join } from 'node:path';
import { ApolloDriver, type ApolloDriverConfig } from '@nestjs/apollo';
import { GraphQLModule } from '@nestjs/graphql';
import { Module } from '@nestjs/common';
import { AuthenticationModule } from '@nestjs/authentication';
import { FixturePersistence } from './persistence/fixture-persistence';
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

@Module({
  imports: [
    AppConfigModule,
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
          const code = error.extensions?.code;
          const safeCode =
            code === 'INFRASTRUCTURE_PROBE_FAILED' || code === 'UNAUTHENTICATED'
              ? code
              : 'GRAPHQL_REQUEST_FAILED';
          return {
            message:
              safeCode === 'INFRASTRUCTURE_PROBE_FAILED'
                ? 'Infrastructure probe unavailable.'
                : safeCode === 'UNAUTHENTICATED'
                  ? 'Authentication required.'
                  : 'GraphQL request failed.',
            ...(error.locations ? { locations: error.locations } : {}),
            ...(error.path ? { path: error.path } : {}),
            extensions: { code: safeCode },
          };
        },
      }),
    }),
  ],
  controllers: [HealthController, IdentityProviderController],
  providers: [
    Database,
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
