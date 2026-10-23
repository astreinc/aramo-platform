import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app/app.module.js';

// ATI-SEP-1 T0 (ADR-0036) — the Talent Intelligence service. Container-internal
// only: no nginx upstream; the api reaches it at http://talent-intelligence-service:3004.
// Ports: api=3000, auth=3001, platform-admin=3002, sign-service=3003, TI=3004.
const DEFAULT_PORT = 3004;

async function bootstrap(): Promise<void> {
  const port = process.env['PORT'] ?? DEFAULT_PORT;
  const app = await NestFactory.create(AppModule);
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.enableShutdownHooks();
  Logger.log('aramo talent-intelligence-service starting', 'Bootstrap');
  await app.listen(port);
}

void bootstrap();
