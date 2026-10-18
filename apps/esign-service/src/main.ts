import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';

import { AppModule } from './app/app.module.js';

async function bootstrap(): Promise<void> {
  const port = process.env['PORT'] ?? 3003;
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // PX-1 — sender PDF upload travels as base64 JSON (25 MiB source ceiling →
  // ≈34 MiB encoded). Express's default JSON limit (100 KB) would refuse it.
  app.useBodyParser('json', { limit: '36mb' });
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  // E-Sign OC v2 (DEC-B) — enable Nest lifecycle signals so the outbound delivery
  // worker stops cleanly (onApplicationShutdown) on SIGTERM/SIGINT.
  app.enableShutdownHooks();
  Logger.log('aramo esign-service starting', 'Bootstrap');
  await app.listen(port);
}

void bootstrap();
