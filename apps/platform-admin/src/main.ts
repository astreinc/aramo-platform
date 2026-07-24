import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';

import { AppModule } from './app/app.module.js';
import { applyTrustProxy } from './trust-proxy.js';

// AUTHZ-2 bootstrap. Mirrors apps/auth-service main.ts 1:1 — same
// ValidationPipe options, same cookie-parser middleware order. The
// platform-admin app is the Option-1 structural separation of D1 (a
// SEPARATE Nest deployable; platform-tier code physically cannot leak
// into tenant code because they live in different bundles + behind
// different IAM roles + behind different Cognito user pools).
async function bootstrap(): Promise<void> {
  const port = process.env['PORT'] ?? 3002;
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // Front-Door PR-1 (D-PROXY-IP-1 / Ruling 3): trust exactly one proxy hop
  // BEFORE any middleware. platform-admin has no budget sites today, but the
  // topology is uniform across all three deployables (Ruling 2).
  applyTrustProxy(app);
  app.use(cookieParser());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  Logger.log('aramo platform-admin starting', 'Bootstrap');
  await app.listen(port);
}

void bootstrap();
