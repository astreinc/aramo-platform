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
import { OutboxPublisherProcessor } from './outbox-publisher.processor.js';
import { OUTBOX_PUBLISHER_QUEUE_NAME } from './outbox-publisher.queue.constants.js';
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
// M5 PR-11 §4.2 + §4.3: BullModule wiring for the stale-consent +
// outbox-publisher daily jobs (Architecture v2.1 §9.2 / Plan v1.5 §M5
// Track A item 6 binding; doc/01 §13 anchor). Mirrors libs/matching
// MatchingModule pattern exactly (ADR-0018 Decision 1):
//   - BullModule.forRootAsync with manualRegistration so workers do not
//     construct at module init (the 5-layer no-network-at-boot guarantee).
//   - BullModule.registerQueue for each owned queue.
//   - Processor providers + per-processor AramoLogger factory tokens.
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
    BullModule.registerQueue({ name: OUTBOX_PUBLISHER_QUEUE_NAME }),
  ],
  controllers: [ConsentController],
  providers: [
    ConsentService,
    ConsentRepository,
    IdempotencyService,
    OutboxPublisherRepository,
    OutboxPublisherProcessor,
    PrismaService,
    SourceConsentService,
    StaleConsentProcessor,
    StaleConsentRepository,
    { provide: APP_FILTER, useClass: AramoExceptionFilter },
    {
      provide: 'StaleConsentProcessorLogger',
      useFactory: () => createAramoLogger(StaleConsentProcessor.name),
    },
    {
      provide: 'OutboxPublisherProcessorLogger',
      useFactory: () => createAramoLogger(OutboxPublisherProcessor.name),
    },
  ],
  exports: [ConsentService, IdempotencyService, SourceConsentService],
})
export class ConsentModule {}
