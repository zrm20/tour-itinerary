import { Catch, UseFilters } from '@nestjs/common';
import {
  Args,
  type GqlExceptionFilter,
  Mutation,
  Query,
  Resolver,
} from '@nestjs/graphql';
import { CurrentUser } from '@nestjs/authentication';
import { GraphQLError } from 'graphql';
import type { User } from '../generated/graphql';
import {
  InvalidTourName,
  TourAccessDenied,
  ToursService,
} from './tours.service';

@Catch(InvalidTourName, TourAccessDenied)
class TourErrorFilter implements GqlExceptionFilter {
  catch(error: InvalidTourName | TourAccessDenied): GraphQLError {
    return new GraphQLError('Tour operation rejected.', {
      extensions: {
        code: error instanceof InvalidTourName ? 'BAD_USER_INPUT' : 'FORBIDDEN',
      },
    });
  }
}

@Resolver('Tour')
@UseFilters(TourErrorFilter)
export class ToursResolver {
  constructor(private readonly tours: ToursService) {}

  @Query()
  myTours(@CurrentUser() user: User) {
    return this.tours.list(user.id);
  }

  @Query()
  tour(@CurrentUser() user: User, @Args('id') id: string) {
    return this.tours.read(user.id, id);
  }

  @Mutation()
  renameTour(
    @CurrentUser() user: User,
    @Args('id') id: string,
    @Args('name') name: string,
  ) {
    return this.tours.rename(user.id, id, name);
  }

  @Mutation()
  createTour(
    @CurrentUser() user: User,
    @Args('organizationId') organizationId: string,
    @Args('name') name: string,
  ) {
    return this.tours.create(user.id, organizationId, name);
  }
}
