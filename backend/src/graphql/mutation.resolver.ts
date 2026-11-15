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
import {
  InvalidOwnNames,
  InvalidUserDeletion,
  UsersService,
} from '../users/users.service';

@Catch(InvalidOwnNames, InvalidUserDeletion)
class UserInputErrorFilter implements GqlExceptionFilter {
  catch(exception: InvalidOwnNames | InvalidUserDeletion): GraphQLError {
    return new GraphQLError(exception.message, {
      extensions: { code: 'BAD_USER_INPUT' },
    });
  }
}

@Resolver()
export class MutationResolver {
  constructor(private readonly users: UsersService) {}

  @Mutation()
  @UseFilters(UserInputErrorFilter)
  deleteOwnUser(@CurrentUser() user: User) {
    return this.users.deleteOwn(user.id);
  }

  @Mutation()
  @UseFilters(UserInputErrorFilter)
  updateOwnNames(
    @CurrentUser() user: User,
    @Args('input') input: UpdateOwnNamesInput,
  ): Promise<User> {
    return this.users.updateOwnNames(user.id, input);
  }
}
