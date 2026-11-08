import { Catch, UseFilters } from '@nestjs/common';
import {
  Args,
  Mutation,
  Resolver,
  type GqlExceptionFilter,
} from '@nestjs/graphql';
import { CurrentUser } from '@nestjs/authentication';
import { GraphQLError } from 'graphql';
import type { User, UpdateOwnNamesInput } from '../generated/graphql';
import { InvalidOwnNames, UsersService } from '../users/users.service';

@Catch(InvalidOwnNames)
class InvalidOwnNamesFilter implements GqlExceptionFilter {
  catch(exception: InvalidOwnNames): GraphQLError {
    return new GraphQLError(exception.message, {
      extensions: { code: 'BAD_USER_INPUT' },
    });
  }
}

@Resolver()
export class MutationResolver {
  constructor(private readonly users: UsersService) {}

  @Mutation()
  @UseFilters(InvalidOwnNamesFilter)
  updateOwnNames(
    @CurrentUser() user: User,
    @Args('input') input: UpdateOwnNamesInput,
  ): Promise<User> {
    return this.users.updateOwnNames(user.id, input);
  }
}
