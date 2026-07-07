import { Inject, Injectable } from '@nestjs/common';
import { type AramoLogger } from '@aramo/common';
import { SubjectMatcherService, TalentTrustRepository } from '@aramo/talent-trust';

import { MATCH_SWEEP_BATCH_SIZE } from './match-sweep.queue.constants.js';

// TR-6 B1 (DDR §2) — the scheduled incremental match sweep's drain seam. The
// recurring analogue of backfillMatches: instead of re-sweeping every anchored
// subject each run, it drains only the subjects the incremental gate query returns
// (ACTIVE, with a new anchor since last_matched_at), re-matches each via the SAME
// matcher core (so D2 fixpoint keying + D3 fan-out guard are inherited), and stamps
// the watermark per subject on completion.
//
// Per-item isolation (the reconcile-poll precedent): one subject's failure bumps
// nothing and leaves its watermark un-advanced (the next tick re-selects it); it
// never aborts the batch. Idempotent — the advisory canonical-pair unique key
// dedupes, and a re-swept subject simply re-stamps the same watermark.

export interface MatchSweepTickResult {
  attempted: number;
  matched: number;
  failed: number;
}

@Injectable()
export class MatchSweepService {
  constructor(
    private readonly repo: TalentTrustRepository,
    private readonly matcher: SubjectMatcherService,
    @Inject('MatchSweepServiceLogger')
    private readonly logger: AramoLogger,
  ) {}

  async drainBatch(args: { batchSize: number }): Promise<MatchSweepTickResult> {
    const subjects = await this.repo.listSubjectsToMatch(args.batchSize);
    if (subjects.length === 0) {
      return { attempted: 0, matched: 0, failed: 0 };
    }

    let matched = 0;
    let failed = 0;
    for (const s of subjects) {
      try {
        await this.matcher.matchSubject(s.tenant_id, s.subject_id);
        // Watermark LAST — a transient matcher failure leaves it un-advanced so the
        // next tick re-selects the subject (bounded by the gate, not an attempt cap:
        // a persistently-failing subject re-queues but the batch never stalls).
        await this.repo.setLastMatchedAt(s.subject_id, new Date());
        matched += 1;
      } catch (err) {
        failed += 1;
        this.logger.warn({
          event: 'match_sweep_subject_failed',
          subject_id: s.subject_id,
          tenant_id: s.tenant_id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return { attempted: subjects.length, matched, failed };
  }

  async tick(): Promise<MatchSweepTickResult> {
    const result = await this.drainBatch({ batchSize: MATCH_SWEEP_BATCH_SIZE });
    this.logger.log({
      event: 'match_sweep_tick_completed',
      attempted: result.attempted,
      matched: result.matched,
      failed: result.failed,
    });
    return result;
  }
}
