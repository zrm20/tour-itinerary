import { Module } from '@nestjs/common';
import { PersistenceModule } from '../persistence/persistence.module';
import { ToursResolver } from './tours.resolver';
import { ToursService } from './tours.service';

@Module({
  imports: [PersistenceModule],
  providers: [ToursService, ToursResolver],
  exports: [ToursService],
})
export class ToursModule {}
