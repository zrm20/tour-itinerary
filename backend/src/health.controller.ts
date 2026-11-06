import { Controller, Get } from '@nestjs/common';
import { Public } from '@nestjs/authentication';
import { AppConfig } from './app-config';

@Public()
@Controller('health')
export class HealthController {
  constructor(private readonly config: AppConfig) {}

  @Get()
  getHealth(): { status: 'ok'; commit: string } {
    return { status: 'ok', commit: this.config.commit };
  }
}
