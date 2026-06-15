import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { BullModule } from '@nestjs/bullmq';
import {
  AramoExceptionFilter,
  CommonModule,
  createAramoLogger,
  RedisConnectionConfig,
} from '@aramo/common';
import { AuthModule } from '@aramo/auth';

import { ConsentController } from './consent.controller.js';
import { ConsentRepository } from './consent.repository.js';
import { ConsentService } from './consent.service.js';
import { IdempotencyService } from './idempotency.service.js';
import { OutboxPublisherRepository } from './outbox-publisher.repository.js';
import { PrismaService } from './prisma/prisma.service.js';
import { SourceConsentService } from './source-consent.service.js';
import { StaleConsentProcessor } from './stale-consent.processor.js';
import { StaleConsentRepository } from './stale-consent.repository.js';
import { STALE_CONSENT_QUEUE_NAME } from './stale-consent.queue.constants.js';

// M4 PR-3 §4.4 / Ruling 7: IdempotencyService is added as a provider AND
// exported so libs/submittal (and any future module using the same
// consent.IdempotencyKey table) can consume it via ConsentModule import.
//
// M5 PR-11 §4.2: BullModule wiring for the stale-consent daily job
// (Architecture v2.1 §9.2 / Plan v1.5 §M5 Track A item 6 binding;
// doc/01 §13 anchor). Mirrors libs/matching MatchingModule pattern
// exactly (ADR-0018 Decision 1):
//   - BullModule.forRootAsync with manualRegistration so workers do not
//     construct at module init (the 5-layer no-network-at-boot guarantee).
//   - BullModule.registerQueue for each owned queue.
//   - Processor providers + per-processor AramoLogger factory tokens.
//
// M6 PR-2 §4: the outbox-publisher queue + processor + logger factory
// have been RELOCATED to libs/outbox-publisher (the new leaf lib) per
// Amendment §2.4 — moving the publisher out of consent avoids the
// consent → engagement|submittal cycle that would result from injecting
// the engagement + submittal outbox repositories into a publisher living
// here. Consent emission/behavior is UNCHANGED (Ruling 3); only the
// drain-side wiring relocates. The OutboxPublisherRepository (consent-
// side reader/writer) stays in libs/consent and is consumed by the new
// publisher lib via @aramo/consent.
//
// RedisConnectionConfig imported from @aramo/common (extracted from
// libs/matching at PR-11 §4.1) so consent + common + skills-taxonomy
// share one source of truth.
@Module({
  imports: [
    AuthModule,
    CommonModule,
    BullModule.forRootAsync({
      // PR-11 mirror of libs/matching pattern (matching.module.ts:42-92).
      extraOptions: { manualRegistration: true },
      useFactory: (cfg: RedisConnectionConfig) => {
        const baseOpts = {
          skipWaitingForReady: true,
          skipVersionCheck: true,
          skipMetasUpdate: true,
        };
        try {
          return {
            ...baseOpts,
            connection: { ...cfg.connection, lazyConnect: true },
          };
        } catch (err) {
          if (err instanceof Error && err.message === 'REDIS_URL is not configured') {
            return {
              ...baseOpts,
              connection: { host: '127.0.0.1', port: 6379, lazyConnect: true },
            };
          }
          throw err;
        }
      },
      inject: [RedisConnectionConfig],
      extraProviders: [RedisConnectionConfig],
    }),
    BullModule.registerQueue({ name: STALE_CONSENT_QUEUE_NAME }),
  ],
  controllers: [ConsentController],
  providers: [
    ConsentService,
    ConsentRepository,
    IdempotencyService,
    OutboxPublisherRepository,
    PrismaService,
    SourceConsentService,
    StaleConsentProcessor,
    StaleConsentRepository,
    { provide: APP_FILTER, useClass: AramoExceptionFilter },
    {
      provide: 'StaleConsentProcessorLogger',
      useFactory: () => createAramoLogger(StaleConsentProcessor.name),
    },
  ],
  // M6 PR-2 §4 — OutboxPublisherRepository is now exported so the new
  // libs/outbox-publisher leaf lib can consume it via @aramo/consent
  // without re-implementing the consent-side reader/writer.
  exports: [
    ConsentService,
    IdempotencyService,
    OutboxPublisherRepository,
    SourceConsentService,
    // Segment 3 — read-only batch consent summary for the talent-records list
    // enrichment (apps/api composer). Read accessor only; no write path.
    ConsentRepository,
  ],
})
export class ConsentModule {}
