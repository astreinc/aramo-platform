import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';

import { AppModule } from './app/app.module.js';

async function bootstrap(): Promise<void> {
  const port = process.env['PORT'] ?? 3003;
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  Logger.log('aramo esign-service starting', 'Bootstrap');
  await app.listen(port);
}

void bootstrap();
