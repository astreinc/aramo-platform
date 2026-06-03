import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import {
  CommonModule,
  createAramoLogger,
  RedisConnectionConfig,
} from '@aramo/common';
import { CanonicalizationModule } from '@aramo/canonicalization';
import { ConsentModule } from '@aramo/consent';
import { EngagementModule } from '@aramo/engagement';
import { SubmittalModule } from '@aramo/submittal';

import { OutboxPublisherProcessor } from './outbox-publisher.processor.js';
import { OUTBOX_PUBLISHER_QUEUE_NAME } from './outbox-publisher.queue.constants.js';

// M6 PR-2 §4 — OutboxPublisherModule (new leaf lib).
//
// Hosts the relocated outbox publisher BullMQ wiring per M6 PR-2 §4 /
// Amendment §2.4. The publisher previously lived in libs/consent (M5
// PR-11 placement) but moves here at M6 to drain consent + engagement +
// submittal outbox tables without creating a consent →
// engagement|submittal cycle (lint-nx-boundaries / import-x/no-cycle
// enforcement). The new lib is a leaf in the consumer direction —
// imported only by apps/api; consent/engagement/submittal are NOT
// modified to import this lib.
//
// BullMQ wiring mirrors libs/consent ConsentModule + libs/matching
// MatchingModule pattern verbatim (ADR-0018 Decision 1):
//   - BullModule.forRootAsync with manualRegistration so workers do not
//     construct at module init (the 5-layer no-network-at-boot guarantee).
//     Multiple modules registering forRootAsync is the established
//     workspace pattern; NestJS BullModule short-circuits on duplicate
//     forRoot.
//   - BullModule.registerQueue for the OUTBOX_PUBLISHER_QUEUE_NAME queue.
//   - OutboxPublisherProcessor provider + Style A
//     'OutboxPublisherProcessorLogger' factory token.
//
// Imports (forward edges only — none of these import outbox-publisher):
//   - CommonModule — RedisConnectionConfig + AramoLogger.
//   - ConsentModule — exports OutboxPublisherRepository (consent-side
//     reader/writer; emission stays in libs/consent per Ruling 3).
//   - EngagementModule — exports EngagementOutboxRepository.
//   - SubmittalModule — exports SubmittalOutboxRepository.
//   - CanonicalizationModule — exports CanonicalizationOutboxRepository
//     (T2-2b: the 4th-schema drain edge; canonicalization is the leaf
//     here too — it does not import outbox-publisher).
@Module({
  imports: [
    CommonModule,
    ConsentModule,
    EngagementModule,
    SubmittalModule,
    CanonicalizationModule,
    BullModule.forRootAsync({
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
    BullModule.registerQueue({ name: OUTBOX_PUBLISHER_QUEUE_NAME }),
  ],
  providers: [
    OutboxPublisherProcessor,
    {
      provide: 'OutboxPublisherProcessorLogger',
      useFactory: () => createAramoLogger(OutboxPublisherProcessor.name),
    },
  ],
})
export class OutboxPublisherModule {}
