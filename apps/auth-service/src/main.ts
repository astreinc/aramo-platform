import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';

import { AppModule } from './app/app.module.js';
import { applyTrustProxy } from './trust-proxy.js';

async function bootstrap(): Promise<void> {
  const port = process.env['PORT'] ?? 3001;
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // Front-Door PR-1 (D-PROXY-IP-1 / Ruling 3): trust exactly one proxy hop
  // BEFORE any middleware, so req.ip resolves to the proxy-observed client IP
  // and PortalLoginBudget keys per-client (not the single proxy socket peer).
  applyTrustProxy(app);
  app.use(cookieParser());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  Logger.log('aramo-core auth-service starting', 'Bootstrap');
  await app.listen(port);
}

void bootstrap();
