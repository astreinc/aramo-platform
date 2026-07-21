import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import express from 'express';

import { AppModule } from './app.module.js';
import { registerBackgroundJobSchedules } from './jobs/registration.js';
import {
  INDEED_APPLY_MAX_BODY_BYTES,
  INDEED_APPLY_WEBHOOK_ROUTE,
} from './webhooks/indeed-apply.constants.js';

async function bootstrap(): Promise<void> {
  const port = process.env['PORT'] ?? 3000;
  // SRC-1 PR-2 (RECON-3c): bodyParser is disabled at create() so we control
  // parser ORDER — the Indeed apply webhook needs the RAW request bytes (the
  // X-Indeed-Signature HMAC covers them), and Express body parsers consume the
  // stream in registration order, so a route-scoped raw parser must be mounted
  // BEFORE the JSON parser. Every OTHER route keeps the default JSON+urlencoded
  // behaviour (re-added explicitly below), untouched.
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  // PR-8.0b directive §8.4: parse cookies so JwtAuthGuard can read the
  // `aramo_access_token` access cookie when the Authorization header is
  // absent. No signed cookies (directive §3 Topic 3).
  app.use(cookieParser());
  // Route-scoped RAW body for the Indeed apply webhook ONLY: raw Buffer, its own
  // larger size cap (base64 résumé payloads), mounted at the exact path and
  // BEFORE json — body-parser marks req._body once it reads, so json/urlencoded
  // skip the already-consumed webhook body while parsing every other route.
  app.use(
    INDEED_APPLY_WEBHOOK_ROUTE,
    express.raw({ type: () => true, limit: INDEED_APPLY_MAX_BODY_BYTES }),
  );
  // Restore Nest's default global parsers for every other route (behaviour-
  // preserving — Nest uses express json+urlencoded under the hood).
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  // class-validator at the controller boundary. whitelist+forbidNonWhitelisted
  // enforces the OpenAPI `additionalProperties: false` contract for every DTO.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  // M5 PR-11 §4.6 — register 4 Aramo Core BullMQ repeating job schedules
  // (Architecture v2.1 §9.2 / Plan v1.5 §M5 Track A item 6). Gated on
  // RedisConnectionConfig.isConfigured so REDIS_URL-less environments boot
  // silently.
  await registerBackgroundJobSchedules(app);
  Logger.log('aramo-core api starting', 'Bootstrap');
  await app.listen(port);
}

void bootstrap();
