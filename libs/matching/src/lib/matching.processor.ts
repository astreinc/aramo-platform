import { Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { BullRegistrar, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';

import type { MatchingAnalysisInput } from './dto/matching-analysis-input.dto.js';
import { MATCH_QUEUE_NAME } from './match-queue.constants.js';
import { MatchingService } from './matching.service.js';

// M3 PR-3 §4.5 — matching worker/processor for the "match" queue
// (Architecture v2.1 §9.2 vocabulary). Consumes MatchingAnalysisInput
// jobs and invokes MatchingService.evaluateAndPersist so the engine
// result is persisted via PR-1's ExaminationRepository in the same
// flow as the synchronous service.
//
// The processor is the async-execution seam: enqueueing a job from a
// future "Talent updated → matching scheduled" trigger (explicitly OUT
// of scope per directive §5) will run the engine + persistence path
// here. PR-3 only wires the worker; the production enqueue trigger is
// deferred. The integration spec exercises the seam end-to-end via a
// test-only enqueue.
//
// Lead Gate-5 fix ruling (Option B, lazy validation):
//   - MatchingModule sets `extraOptions.manualRegistration = true`, so
//     BullMQ does NOT construct the underlying Worker at module init.
//     This is critical because the Worker's blockingConnection is a
//     separate RedisConnection that ignores `skipWaitingForReady` (Bull
//     design), and its waitUntilReady would otherwise hang indefinitely
//     when REDIS_URL is unset.
//   - skipWaitingForReady + skipVersionCheck on the Worker's main
//     RedisConnection let its init() complete without network work once
//     register() does build the Worker.
//   - onApplicationBootstrap fires after onModuleInit, when env is fully
//     loaded. We inspect REDIS_URL there: if it is configured we call
//     BullRegistrar.register() to build the Worker (which then starts
//     its BLPOP loop against the real Redis); if it is absent we log a
//     warning and leave the worker unregistered. The directive's "Only
//     an actual queue push/pop may surface a missing/unreachable Redis"
//     gate is then met — boot is silent, push/pop fails on demand.
@Processor(MATCH_QUEUE_NAME, {
  skipWaitingForReady: true,
  skipVersionCheck: true,
})
export class MatchingProcessor
  extends WorkerHost
  implements OnApplicationBootstrap
{
  private readonly logger = new Logger(MatchingProcessor.name);

  constructor(
    private readonly matching: MatchingService,
    private readonly registrar: BullRegistrar,
  ) {
    super();
  }

  async process(job: Job<MatchingAnalysisInput>): Promise<void> {
    this.logger.debug(`processing match job ${job.id ?? '(no id)'} for talent ${job.data.talent_id}`);
    await this.matching.evaluateAndPersist(job.data);
  }

  onApplicationBootstrap(): void {
    const redisUrl = process.env['REDIS_URL'] ?? '';
    if (redisUrl.length === 0) {
      this.logger.warn(
        'REDIS_URL is not configured; match-queue worker remains unregistered. ' +
          'Set REDIS_URL to enable async matching execution.',
      );
      return;
    }
    this.registrar.register();
  }
}
