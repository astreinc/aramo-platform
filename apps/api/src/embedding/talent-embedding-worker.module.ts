import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { CommonModule, createAramoLogger, RedisConnectionConfig } from '@aramo/common';

import { EmbeddingModule } from './embedding.module.js';
import { TalentEmbeddingProcessor } from './talent-embedding.processor.js';
import { TALENT_EMBEDDING_QUEUE_NAME } from './talent-embedding.queue.constants.js';

// Enterprise Search GS-2A Slice-5b — the talent-embedding worker module (apps/api composition root).
// Imports EmbeddingModule (the reconcile sweep + lifecycle worker). BullMQ wiring mirrors
// LifecyclePollModule verbatim: forRootAsync with manualRegistration + lazyConnect + a
// RedisConnectionConfig factory; registerQueue for the one queue with NO repeat (the SCHEDULES
// registrar enqueues the repeat tick). The processor gates on RedisConnectionConfig.isConfigured
// (silent when REDIS_URL is absent) AND every step is EMBEDDING_PROCESSING_ENABLED-dark.
@Module({
  imports: [
    CommonModule,
    EmbeddingModule,
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
    BullModule.registerQueue({ name: TALENT_EMBEDDING_QUEUE_NAME }),
  ],
  providers: [
    TalentEmbeddingProcessor,
    {
      provide: 'TalentEmbeddingProcessorLogger',
      useFactory: () => createAramoLogger(TalentEmbeddingProcessor.name),
    },
  ],
})
export class TalentEmbeddingWorkerModule {}
