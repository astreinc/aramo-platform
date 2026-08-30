import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { CommonModule, createAramoLogger, RedisConnectionConfig } from '@aramo/common';
import { PipelineModule } from '@aramo/pipeline';
import {
  PlacementPipelineBridgeModule,
  PlacementPipelineBridgePrismaService,
} from '@aramo/placement-pipeline-bridge';

import { PlacementLifecycleOrchestratorService } from './placement-lifecycle-orchestrator.service.js';
import { PlacementLifecycleOrchestratorProcessor } from './placement-lifecycle-orchestrator.processor.js';
import { PLACEMENT_LIFECYCLE_QUEUE_NAME } from './placement-lifecycle.queue.constants.js';

// Lane 2 / L2-G (Part 3, R-BRIDGE/R-CMD/R-PROC) — the placement→pipeline lifecycle
// orchestrator module (apps/api composition root). Imports:
//   - PipelineModule           → the system-gated PipelineRepository (complete / dispositionDownstream)
//   - PlacementPipelineBridgeModule → the idempotent-consumer inbox (+ its PrismaService,
//                                     which is ALSO the raw cross-schema reader bound below)
// The orchestrator reads placement.OutboxEvent + submittal.TalentSubmittalRecord via raw SQL
// on the SAME connection (all in one physical DB); 'PlacementLifecycleDb' is bound useExisting
// to the bridge PrismaService so there is ONE pooled client. Placement is NOT imported (the
// orchestrator only reads its outbox by raw SQL — no lifecycle-rule coupling). BullMQ wiring
// mirrors ReconciliationDrainModule verbatim (manualRegistration + lazyConnect + Redis gate).
@Module({
  imports: [
    CommonModule,
    PipelineModule,
    PlacementPipelineBridgeModule,
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
    BullModule.registerQueue({ name: PLACEMENT_LIFECYCLE_QUEUE_NAME }),
  ],
  providers: [
    PlacementLifecycleOrchestratorService,
    PlacementLifecycleOrchestratorProcessor,
    {
      // The raw cross-schema reader IS the bridge's pooled PrismaService (one connection).
      provide: 'PlacementLifecycleDb',
      useExisting: PlacementPipelineBridgePrismaService,
    },
    {
      provide: 'PlacementLifecycleOrchestratorLogger',
      useFactory: () => createAramoLogger(PlacementLifecycleOrchestratorService.name),
    },
  ],
})
export class PlacementLifecycleOrchestratorModule {}
