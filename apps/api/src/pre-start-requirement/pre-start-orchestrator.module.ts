import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { CommonModule, createAramoLogger, RedisConnectionConfig } from '@aramo/common';
import { PrismaService as PreStartPrismaService } from '@aramo/pre-start-requirement';

import { PreStartRequirementModule } from './pre-start-requirement.module.js';
import { PreStartOrchestratorService } from './pre-start-orchestrator.service.js';
import { PreStartOrchestratorProcessor } from './pre-start-orchestrator.processor.js';
import { PRE_START_ORCHESTRATOR_QUEUE_NAME } from './pre-start-orchestrator.queue.constants.js';

// Lane 5 / L5-P1 (E2 ignition) — the pre-start orchestrator worker module (apps/api
// composition root). Imports PreStartRequirementModule (exports the governed E2 seams:
// PreStartMaterializationService, PreStartCancellationService, and the shared
// PreStartPrismaService bound below as the raw cross-schema reader — ONE pooled client).
// BullMQ wiring mirrors OfferExpiryModule / PlacementLifecycleOrchestratorModule verbatim:
// forRootAsync with manualRegistration + lazyConnect + a RedisConnectionConfig factory;
// registerQueue for the one queue with NO repeat (the SCHEDULES registrar enqueues the
// repeat tick). The worker gates on RedisConnectionConfig.isConfigured (silent when
// REDIS_URL is absent — CI / local).
@Module({
  imports: [
    CommonModule,
    PreStartRequirementModule,
    BullModule.forRootAsync({
      extraOptions: { manualRegistration: true },
      useFactory: (cfg: RedisConnectionConfig) => {
        const baseOpts = {
          skipWaitingForReady: true,
          skipVersionCheck: true,
          skipMetasUpdate: true,
        };
        try {
          return { ...baseOpts, connection: { ...cfg.connection, lazyConnect: true } };
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
    BullModule.registerQueue({ name: PRE_START_ORCHESTRATOR_QUEUE_NAME }),
  ],
  providers: [
    PreStartOrchestratorService,
    PreStartOrchestratorProcessor,
    {
      // The raw cross-schema reader IS the shared pre-start PrismaService (one pooled
      // client on the physical DB; raw $queryRawUnsafe reads placement.OutboxEvent too).
      // Bound under a dedicated STRING token — never a second bare-class provider.
      provide: 'PreStartOrchestratorDb',
      useExisting: PreStartPrismaService,
    },
    {
      provide: 'PreStartOrchestratorLogger',
      useFactory: () => createAramoLogger(PreStartOrchestratorService.name),
    },
  ],
})
export class PreStartOrchestratorModule {}
