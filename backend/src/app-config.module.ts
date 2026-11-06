import { Module } from '@nestjs/common';
import { AppConfig } from './app-config';

@Module({
  providers: [
    { provide: AppConfig, useFactory: () => new AppConfig(process.env) },
  ],
  exports: [AppConfig],
})
export class AppConfigModule {}
