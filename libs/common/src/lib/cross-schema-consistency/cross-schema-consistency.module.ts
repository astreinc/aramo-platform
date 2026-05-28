import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';

import { CommonModule } from '../common.module.js';
import { createAramoLogger } from '../logging/index.js';
import { CrossSchemaConsistencyProcessor } from '../cross-schema-consistency.processor.js';
import { CrossSchemaConsistencyRepository } from '../cross-schema-consistency.repository.js';
import { CROSS_SCHEMA_CONSISTENCY_QUEUE_NAME } from '../cross-schema-consistency.queue.constants.js';
import { RedisConnectionConfig } from '../redis/redis-connection.config.js';

// M5 PR-11 Gate 5-redux (Option β-1; PL-88 ratification):
//
// Dedicated module for the cross-schema-consistency BullMQ job. EXTRACTED
// from CommonModule because BullExplorer auto-registers Workers at
// onModuleInit; placing a processor in CommonModule leaked Worker
// instantiation into every consumer graph (apps/auth-service pact provider,
// future narrow modules) and failed when no REDIS_URL was set in those
// contexts.
//
// PL-88 (RATIFIED at Gate 5-redux): BullMQ processors live in dedicated
// job-modules within their owning lib, NEVER in CommonModule or other
// broadly-imported universal-utility modules. CommonModule provides
// RedisConnectionConfig (config-only, no Worker) — that's the cross-lib
// reuse path. Workers live in their own modules.
//
// Lifecycle mirrors libs/matching pattern exactly (ADR-0018 Decision 1;
// libs/consent + libs/skills-taxonomy follow the same template):
//   - BullModule.forRootAsync with extraOptions.manualRegistration: true
//     so BullExplorer SKIPS auto-registration of Workers at onModuleInit.
//   - 5-layer no-network-at-boot config (manualRegistration +
//     skipWaitingForReady + skipVersionCheck + skipMetasUpdate +
//     lazyConnect on the connection).
//   - Processor's onApplicationBootstrap hook calls BullRegistrar.register()
//     manually IFF RedisConnectionConfig.isConfigured.
//
// AppModule imports this module directly (alongside MatchingModule +
// ConsentModule + SkillsTaxonomyModule). AuthServiceModule does NOT
// import this module — it has no need for the cross-schema scanner and
// therefore does not boot a BullMQ Worker.
@Module({
  imports: [
    CommonModule,
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
    BullModule.registerQueue({ name: CROSS_SCHEMA_CONSISTENCY_QUEUE_NAME }),
  ],
  providers: [
    CrossSchemaConsistencyProcessor,
    CrossSchemaConsistencyRepository,
    {
      provide: 'CrossSchemaConsistencyProcessorLogger',
      useFactory: () => createAramoLogger(CrossSchemaConsistencyProcessor.name),
    },
  ],
  exports: [CrossSchemaConsistencyRepository],
})
export class CrossSchemaConsistencyModule {}
