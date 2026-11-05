import { join } from 'node:path';
import { ApolloDriver, type ApolloDriverConfig } from '@nestjs/apollo';
import { GraphQLModule } from '@nestjs/graphql';
import { FixturePersistence } from './persistence/fixture-persistence';
import { ProbeService } from './probe/probe.service';
import { ProbeResolver } from './probe/probe.resolver';
import { Module } from '@nestjs/common';
import { AppConfig } from './app-config';
import { HealthController } from './health.controller';

@Module({
  imports: [
    GraphQLModule.forRoot<ApolloDriverConfig>({
      driver: ApolloDriver,
      typePaths: [join(__dirname, '**/*.graphql')],
      playground: false,
      includeStacktraceInErrorResponses: false,
      formatError: (error) => ({
        message:
          error.extensions?.code === 'INFRASTRUCTURE_PROBE_FAILED'
            ? 'Infrastructure probe unavailable.'
            : 'GraphQL request failed.',
        ...(error.locations ? { locations: error.locations } : {}),
        ...(error.path ? { path: error.path } : {}),
        extensions: {
          code:
            error.extensions?.code === 'INFRASTRUCTURE_PROBE_FAILED'
              ? 'INFRASTRUCTURE_PROBE_FAILED'
              : 'GRAPHQL_REQUEST_FAILED',
        },
      }),
    }),
  ],
  controllers: [HealthController],
  providers: [
    ProbeService,
    ProbeResolver,
    {
      provide: FixturePersistence,
      useFactory: () => new FixturePersistence(process.env.DATABASE_URL),
    },
    { provide: AppConfig, useFactory: () => new AppConfig(process.env) },
  ],
})
export class AppModule {}
