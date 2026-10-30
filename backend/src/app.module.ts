import { Module } from '@nestjs/common';
import { AppConfig } from './app-config';
import { HealthController } from './health.controller';

@Module({
  controllers: [HealthController],
  providers: [
    { provide: AppConfig, useFactory: () => new AppConfig(process.env) },
  ],
})
export class AppModule {}
