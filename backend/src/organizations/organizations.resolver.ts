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
  InvalidOrganizationName,
  InvalidOwnershipChange,
  OrganizationAccessDenied,
  OrganizationsService,
} from './organizations.service';

@Catch(
  InvalidOrganizationName,
  InvalidOwnershipChange,
  OrganizationAccessDenied,
)
class OrganizationErrorFilter implements GqlExceptionFilter {
  catch(
    error:
      | InvalidOrganizationName
      | InvalidOwnershipChange
      | OrganizationAccessDenied,
  ): GraphQLError {
    if (
      error instanceof InvalidOrganizationName ||
      error instanceof InvalidOwnershipChange
    ) {
      return new GraphQLError(error.message, {
        extensions: { code: 'BAD_USER_INPUT' },
      });
    }
    return new GraphQLError(error.message, {
      extensions: { code: 'FORBIDDEN' },
    });
  }
}

@Resolver('Organization')
@UseFilters(OrganizationErrorFilter)
export class OrganizationsResolver {
  constructor(private readonly organizations: OrganizationsService) {}

  @Query()
  organizationOwners(
    @CurrentUser() user: User,
    @Args('organizationId') id: string,
  ) {
    return this.organizations.listOwners(user.id, id);
  }

  @Mutation()
  grantOrganizationOwner(
    @CurrentUser() user: User,
    @Args('organizationId') id: string,
    @Args('userId') targetId: string,
  ) {
    return this.organizations.changeOwner(user.id, id, targetId, true);
  }

  @Mutation()
  removeOrganizationOwner(
    @CurrentUser() user: User,
    @Args('organizationId') id: string,
    @Args('userId') targetId: string,
  ) {
    return this.organizations.changeOwner(user.id, id, targetId, false);
  }

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
