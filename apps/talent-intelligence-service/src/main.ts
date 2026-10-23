import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';

import { AppModule } from './app/app.module.js';

// ATI-SEP-1 (ADR-0036) — the Talent Intelligence service. Container-internal
// only: no nginx upstream; the api reaches it at http://talent-intelligence-service:3004.
// Ports: api=3000, auth=3001, platform-admin=3002, sign-service=3003, TI=3004.
//
// Env: INTELLIGENCE_DATABASE_URL (required, boot fails closed),
// INTELLIGENCE_SERVICE_TOKEN_SECRET (>= 32 chars, token exchange + guard),
// INTELLIGENCE_GOV_ID_TOKEN_KEY (>= 32 chars, government-identifier tokens).
const DEFAULT_PORT = 3004;

async function bootstrap(): Promise<void> {
  const port = process.env['PORT'] ?? DEFAULT_PORT;
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
  // A full talent snapshot can exceed the 100kb default; the admission schema caps its size.
  app.useBodyParser('json', { limit: '1mb' });
  app.useBodyParser('urlencoded', { extended: false, limit: '16kb' });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.enableShutdownHooks();
  Logger.log('aramo talent-intelligence-service starting', 'Bootstrap');
  await app.listen(port);
}

void bootstrap();
