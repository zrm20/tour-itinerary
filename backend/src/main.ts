import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppConfig } from './app-config';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { abortOnError: false });
  app.enableShutdownHooks();
  await app.listen(app.get(AppConfig).port, '0.0.0.0');
}

bootstrap().catch((error: unknown) => {
  console.error(
    error instanceof Error ? error.message : 'Application failed to start',
  );
  process.exitCode = 1;
});
