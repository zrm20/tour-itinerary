import { Resolver, Query } from '@nestjs/graphql';
import { CurrentUser } from '@nestjs/authentication';
import type { QueryResolvers, User } from '../generated/graphql';

@Resolver()
export class QueryResolver implements Pick<QueryResolvers, 'currentUser'> {
  @Query()
  currentUser(@CurrentUser() user: User) { return user; }
}
