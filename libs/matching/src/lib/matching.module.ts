import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { createAramoLogger } from '@aramo/common';
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
// Lead Gate-5 fix ruling (Option B): the factory invokes the lazy
// RedisConnectionConfig.connection accessor at factory-invocation time.
// When REDIS_URL is unset, the accessor throws "REDIS_URL is not
// configured"; the factory catches that specific throw and returns a
// placeholder ioredis connection with lazyConnect: true so module init
// completes without a TCP attempt. The directive §4.2 intent — "Only an
// actual queue push/pop may surface a missing/unreachable Redis" — is
// then met: ioredis only attempts a connection on first command, and
// that command fails (ECONNREFUSED or similar) for callers that try to
// use the queue without a configured Redis. lazyConnect: true is also
// applied on the success path so a configured-but-unreachable Redis
// fails at first push/pop rather than at boot.
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
      // Lead Gate-5 fix — five-layer no-network-at-boot configuration:
      //   1. manualRegistration: defers BullMQ Worker construction (and its
      //      blockingConnection, which does NOT honor skipWaitingForReady)
      //      until BullRegistrar.register() is called. MatchingProcessor
      //      calls register() from onApplicationBootstrap only when REDIS_URL
      //      is configured, so missing-REDIS_URL boots create no Worker.
      //   2. skipWaitingForReady: BullMQ's RedisConnection.init() skips
      //      its waitUntilReady() call (which otherwise force-connects an
      //      ioredis client in 'wait' state).
      //   3. skipVersionCheck: init() returns a synthetic version instead
      //      of issuing client.info() (which would force-connect).
      //   4. skipMetasUpdate: Queue's constructor skips its post-init
      //      client.hmset(meta, ...) call — that hmset would otherwise
      //      auto-connect ioredis via sendCommand on 'wait' status.
      //   5. lazyConnect: ioredis stays in 'wait' state at construction;
      //      a TCP connection is only initiated when a real command runs.
      // Together these guarantee no network work at module init regardless
      // of whether REDIS_URL is set or whether a Redis is live — the
      // directive's "Only an actual queue push/pop may surface a missing/
      // unreachable Redis" gate.
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
    BullModule.registerQueue({ name: MATCH_QUEUE_NAME }),
  ],
  // M4-close HK-PR-4 — AramoLogger provider for MatchingProcessor
  // (Style A constructor DI; mirrors libs/submittal PR-9 PoC pattern).
  // libs/matching's first @aramo/common edge; tsconfig.lib.json paths
  // extended to include @aramo/common dist d.ts.
  providers: [
    MatchingService,
    MatchingProcessor,
    {
      provide: 'MatchingProcessorLogger',
      useFactory: () => createAramoLogger(MatchingProcessor.name),
    },
  ],
  exports: [MatchingService],
})
export class MatchingModule {}
