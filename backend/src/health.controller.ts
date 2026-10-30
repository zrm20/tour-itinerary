import { Controller, Get } from '@nestjs/common';
import { AppConfig } from './app-config';

@Controller('health')
export class HealthController {
  constructor(private readonly config: AppConfig) {}

  @Get()
  getHealth(): { status: 'ok'; commit: string } {
    return { status: 'ok', commit: this.config.commit };
  }
}
