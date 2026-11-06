import { Resolver, Query } from '@nestjs/graphql';
import { CurrentUser } from '@nestjs/authentication';
import type { User } from '../generated/graphql';

@Resolver()
export class QueryResolver {
  @Query()
  currentUser(@CurrentUser() user: User): User {
    return user;
  }
}
