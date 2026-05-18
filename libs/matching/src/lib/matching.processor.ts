import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
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
@Processor(MATCH_QUEUE_NAME)
export class MatchingProcessor extends WorkerHost {
  private readonly logger = new Logger(MatchingProcessor.name);

  constructor(private readonly matching: MatchingService) {
    super();
  }

  async process(job: Job<MatchingAnalysisInput>): Promise<void> {
    this.logger.debug(`processing match job ${job.id ?? '(no id)'} for talent ${job.data.talent_id}`);
    await this.matching.evaluateAndPersist(job.data);
  }
}
