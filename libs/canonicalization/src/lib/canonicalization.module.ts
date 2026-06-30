import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import {
  CommonModule,
  createAramoLogger,
  RedisConnectionConfig,
} from '@aramo/common';
import { IdentityIndexModule } from '@aramo/identity-index';
import { IngestionModule } from '@aramo/ingestion';
import { TalentModule } from '@aramo/talent';
import { TalentEvidenceModule } from '@aramo/talent-evidence';

import { CanonicalizationOutboxRepository } from './canonicalization-outbox.repository.js';
import { CanonicalizationRepository } from './canonicalization.repository.js';
import { CanonicalizationService } from './canonicalization.service.js';
import { CanonicalizationTriggerProcessor } from './canonicalization-trigger.processor.js';
import { CANONICALIZATION_TRIGGER_QUEUE_NAME } from './canonicalization-trigger.queue.constants.js';
import { PrismaService } from './prisma/prisma.service.js';

// T2-2a / T2-3 — libs/canonicalization module.
//
//   - New leaf lib in the consumer direction; imports IngestionModule +
//     TalentModule + TalentEvidenceModule (forward edges, no cycle —
//     lint:nx-boundaries enforces). The imports establish the module-graph
//     edges that match the Prisma-schema follower direction: this lib
//     READS the talent / talent_evidence / ingestion schemas via its
//     OWN multi-schema Prisma client (Option A).
//
//   - T2-2a: service-only (no controller). The PR-10 precedent.
//
//   - T2-3 production trigger: the CanonicalizationTriggerProcessor is a
//     BullMQ tick worker that drains unresolved RawPayloadReference rows
//     and invokes canonicalize(). Lives in THIS module (canonicalization
//     already imports ingestion; no reverse edge introduced —
//     lint:nx-boundaries stays green). BullModule wiring mirrors
//     OutboxPublisherModule + MatchingModule verbatim: forRootAsync with
//     manualRegistration + lazyConnect + RedisConnectionConfig factory;
//     registerQueue for the named trigger queue; per-processor logger
//     factory token (Style A).
//
//   - Exports: CanonicalizationService (the public canonicalize() entry
//     point) + CanonicalizationOutboxRepository (consumed by
//     libs/outbox-publisher at T2-2b for the 4th-schema drain).
@Module({
  imports: [
    CommonModule,
    IdentityIndexModule,
    IngestionModule,
    TalentModule,
    TalentEvidenceModule,
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
    BullModule.registerQueue({ name: CANONICALIZATION_TRIGGER_QUEUE_NAME }),
  ],
  providers: [
    PrismaService,
    CanonicalizationRepository,
    CanonicalizationService,
    CanonicalizationOutboxRepository,
    CanonicalizationTriggerProcessor,
    {
      provide: 'CanonicalizationRepositoryLogger',
      useFactory: () => createAramoLogger(CanonicalizationRepository.name),
    },
    {
      provide: 'CanonicalizationTriggerProcessorLogger',
      useFactory: () =>
        createAramoLogger(CanonicalizationTriggerProcessor.name),
    },
  ],
  exports: [
    CanonicalizationService,
    CanonicalizationOutboxRepository,
    CanonicalizationTriggerProcessor,
  ],
})
export class CanonicalizationModule {}
