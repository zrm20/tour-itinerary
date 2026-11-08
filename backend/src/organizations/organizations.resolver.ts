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
import { OrganizationsService } from './organizations.service';

@Catch(GraphQLError)
class OrganizationErrorFilter implements GqlExceptionFilter {
  catch(error: GraphQLError): GraphQLError {
    return error;
  }
}

@Resolver('Organization')
@UseFilters(OrganizationErrorFilter)
export class OrganizationsResolver {
  constructor(private readonly organizations: OrganizationsService) {}

  @Query()
  myOrganizations(@CurrentUser() user: User) {
    return this.organizations.listOwned(user.id);
  }

  @Query()
  organization(@CurrentUser() user: User, @Args('id') id: string) {
    return this.organizations.readOwned(user.id, id);
  }

  @Mutation()
  createOrganization(@CurrentUser() user: User, @Args('name') name: string) {
    return this.organizations.create(user.id, name);
  }

  @Mutation()
  renameOrganization(
    @CurrentUser() user: User,
    @Args('id') id: string,
    @Args('name') name: string,
  ) {
    return this.organizations.renameOwned(user.id, id, name);
  }
}
