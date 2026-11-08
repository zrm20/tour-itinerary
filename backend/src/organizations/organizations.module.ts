import { Module } from '@nestjs/common';
import { PersistenceModule } from '../persistence/persistence.module';
import { OrganizationsResolver } from './organizations.resolver';
import { OrganizationsService } from './organizations.service';

@Module({
  imports: [PersistenceModule],
  providers: [OrganizationsService, OrganizationsResolver],
  exports: [OrganizationsService],
})
export class OrganizationsModule {}
