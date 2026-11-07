import { Public } from '@nestjs/authentication';
import { Catch, Inject, UseFilters } from '@nestjs/common';
import { type GqlExceptionFilter, Query, Resolver } from '@nestjs/graphql';
import { GraphQLError } from 'graphql';
import type { QueryResolvers, ResolversTypes } from '../generated/graphql';
import { ProbeService } from './probe.service';

@Catch()
class ProbeErrorFilter implements GqlExceptionFilter {
  catch(): GraphQLError {
    return new GraphQLError('Infrastructure probe unavailable.', {
      extensions: { code: 'INFRASTRUCTURE_PROBE_FAILED' },
    });
  }
}

@Public()
@Resolver()
export class ProbeResolver implements Pick<
  QueryResolvers,
  'infrastructureProbe'
> {
  constructor(@Inject(ProbeService) private readonly service: ProbeService) {}

  @Query('infrastructureProbe')
  @UseFilters(ProbeErrorFilter)
  async infrastructureProbe(): Promise<ResolversTypes['InfrastructureProbe']> {
    return this.service.execute();
  }
}
