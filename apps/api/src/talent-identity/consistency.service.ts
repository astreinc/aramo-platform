import { Inject, Injectable, type LoggerService } from '@nestjs/common';
import { TalentTrustRepository, TalentTrustService } from '@aramo/talent-trust';

import { CONSISTENCY_BATCH_SIZE } from './consistency.queue.constants.js';

// TR-4 B3 (§3.1) — the consistency detector poll service. Mirrors the TR-6
// match-sweep template: drain a watermark-gated batch, run the deterministic
// detectors per subject over its cluster-union CLAIMS evidence, advance the
// watermark LAST (so a transient failure re-selects the subject next tick). The
// per-item try/catch never aborts the batch. The detectors themselves write only
// through the trust ledger's lifecycle arms + recordEvidence; bands move only
// through the recompute inside runConsistencyForSubject.

export interface ConsistencySweepResult {
  attempted: number;
  checked: number;
  failed: number;
  contradictions: number;
  gaps_opened: number;
  gaps_healed: number;
}

@Injectable()
export class ConsistencyService {
  constructor(
    private readonly repo: TalentTrustRepository,
    private readonly trust: TalentTrustService,
    @Inject('ConsistencyServiceLogger') private readonly logger: LoggerService,
  ) {}

  async drainBatch(args: {
    batchSize: number;
    tenantId?: string;
  }): Promise<ConsistencySweepResult> {
    const subjects = await this.repo.listSubjectsToCheckConsistency(
      args.batchSize,
      args.tenantId,
    );
    const result: ConsistencySweepResult = {
      attempted: subjects.length,
      checked: 0,
      failed: 0,
      contradictions: 0,
      gaps_opened: 0,
      gaps_healed: 0,
    };
    if (subjects.length === 0) return result;

    for (const s of subjects) {
      try {
        const r = await this.trust.runConsistencyForSubject(s.tenant_id, s.subject_id);
        result.contradictions += r.contradictions;
        result.gaps_opened += r.gaps_opened;
        result.gaps_healed += r.gaps_healed;
        // Watermark LAST — an un-advanced stamp on failure re-selects next tick.
        await this.repo.setLastConsistencyAt(s.subject_id, new Date());
        result.checked += 1;
        // TR-12 B1 (DDR §3) — the caseworker, hosted post-recompute (the
        // consistency run recomputes at its end). Own try/catch: a proposal-
        // generation failure must NOT undo the consistency bookkeeping above
        // (the subject stays checked; the proposal re-attempts next visit).
        try {
          await this.trust.generateProposalsForSubject(s.subject_id, s.tenant_id);
        } catch (genErr) {
          this.logger.warn({
            event: 'proposal_generation_failed',
            host: 'consistency',
            tenant_id: s.tenant_id,
            subject_id: s.subject_id,
            error: genErr instanceof Error ? genErr.message : String(genErr),
          });
        }
      } catch (err) {
        result.failed += 1;
        this.logger.warn({
          event: 'consistency_subject_failed',
          tenant_id: s.tenant_id,
          subject_id: s.subject_id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return result;
  }

  // The scheduled seam (the processor calls this; acceptance specs call it directly).
  async tick(): Promise<ConsistencySweepResult> {
    const result = await this.drainBatch({ batchSize: CONSISTENCY_BATCH_SIZE });
    this.logger.log({ event: 'consistency_tick_completed', ...result });
    return result;
  }

  // The manual CLI escape hatch: drain the watermark gate to completion (optionally
  // scoped to one tenant), reporting aggregate counts. Bounded loop (the watermark
  // advances each batch, so the pending set strictly shrinks).
  async runToCompletion(tenantId?: string): Promise<ConsistencySweepResult> {
    const total: ConsistencySweepResult = {
      attempted: 0,
      checked: 0,
      failed: 0,
      contradictions: 0,
      gaps_opened: 0,
      gaps_healed: 0,
    };
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const batch = await this.drainBatch({ batchSize: CONSISTENCY_BATCH_SIZE, tenantId });
      total.attempted += batch.attempted;
      total.checked += batch.checked;
      total.failed += batch.failed;
      total.contradictions += batch.contradictions;
      total.gaps_opened += batch.gaps_opened;
      total.gaps_healed += batch.gaps_healed;
      // A batch that checked nothing new (all failures un-advance, but a full batch
      // of failures would loop) — stop when nothing was attempted or nothing checked.
      if (batch.attempted === 0 || batch.checked === 0) break;
    }
    return total;
  }
}
