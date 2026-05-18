import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ExaminationModule } from '@aramo/examination';

import { MATCH_QUEUE_NAME } from './match-queue.constants.js';
import { MatchingProcessor } from './matching.processor.js';
import { MatchingService } from './matching.service.js';
import { RedisConnectionConfig } from './redis/redis-connection.config.js';

// libs/matching module — M3 PR-2 entrustability engine + persistence
// orchestrator, M3 PR-3 BullMQ/Redis async execution wiring.
//
// PR-3 §4.4: registers BullModule.forRootAsync (Redis connection derived
// from RedisConnectionConfig) AND BullModule.registerQueue (the "match"
// queue, Architecture v2.1 §9.2 vocabulary). The matching processor
// (§4.5) is registered as a provider so Nest instantiates it at module
// init and the BullMQ worker attaches to the queue.
//
// RedisConnectionConfig is declared as an extra provider on the async
// root so the useFactory can inject it without requiring callers to
// import a separate RedisModule.
//
// Out of scope per directive §5: the matching-analysis input layer, the
// production "Talent updated → matching scheduled" enqueue trigger
// (the integration spec's enqueue path is test-only), Live List, the
// read endpoint, Pact, refusal verification, docker-compose.yml,
// .env.example, adapter BullMQ jobs.
@Module({
  imports: [
    ExaminationModule,
    BullModule.forRootAsync({
      useFactory: (cfg: RedisConnectionConfig) => ({
        connection: cfg.connection,
      }),
      inject: [RedisConnectionConfig],
      extraProviders: [RedisConnectionConfig],
    }),
    BullModule.registerQueue({ name: MATCH_QUEUE_NAME }),
  ],
  providers: [MatchingService, MatchingProcessor],
  exports: [MatchingService],
})
export class MatchingModule {}
