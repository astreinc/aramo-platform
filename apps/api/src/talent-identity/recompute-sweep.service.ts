import { Inject, Injectable, type LoggerService } from '@nestjs/common';
import {
  RECOMPUTE_STALENESS_DAYS,
  TalentTrustRepository,
  TalentTrustService,
} from '@aramo/talent-trust';

import { RECOMPUTE_SWEEP_BATCH_SIZE } from './recompute-sweep.queue.constants.js';

// TR-5 B1 (DDR §2) — the decay-recompute sweep service. Mirrors the TR-4
// consistency / TR-6 match-sweep template: drain a time-gated batch and run
// `recomputeTrustState` per subject — NOTHING else. The existing derivation
// already prices decay at read-time and counts staleness; the sweep just makes
// the clock tick, so a band goes honest on schedule instead of only when some
// other write happens to trigger a recompute.
//
// There is NO watermark column here (unlike the TR-4/TR-6 polls): the gate is
// time-driven on the existing TrustState.last_recomputed_at, which
// recomputeTrustState itself advances to `now`. A swept subject therefore falls
// out of the gate immediately — idempotent by construction, no separate stamp.
// The per-item try/catch never aborts the batch (one poisoned subject fails
// loudly; the rest complete).

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface RecomputeSweepResult {
  attempted: number;
  recomputed: number;
  failed: number;
}

@Injectable()
export class RecomputeSweepService {
  constructor(
    private readonly repo: TalentTrustRepository,
    private readonly trust: TalentTrustService,
    @Inject('RecomputeSweepServiceLogger') private readonly logger: LoggerService,
  ) {}

  async drainBatch(args: {
    batchSize: number;
    tenantId?: string;
    now?: Date;
  }): Promise<RecomputeSweepResult> {
    const now = args.now ?? new Date();
    const staleBefore = new Date(now.getTime() - RECOMPUTE_STALENESS_DAYS * MS_PER_DAY);
    const subjects = await this.repo.listSubjectsToRecompute(
      args.batchSize,
      staleBefore,
      args.tenantId,
    );
    const result: RecomputeSweepResult = {
      attempted: subjects.length,
      recomputed: 0,
      failed: 0,
    };
    if (subjects.length === 0) return result;

    for (const s of subjects) {
      try {
        // Per subject: recompute, then the caseworker. The recompute re-prices
        // decay as of now and advances last_recomputed_at (via upsertTrustState)
        // — so the subject leaves the gate.
        await this.trust.recomputeTrustState(s.subject_id, s.tenant_id);
        result.recomputed += 1;
        // TR-12 B1 (DDR §3) — the time-driven host. REQUIRED here (not only in
        // the consistency pass): verified_control_stale flips with ZERO new
        // evidence, so the consistency watermark would never re-select the
        // subject — only the daily recompute sees the clock cross 365d. Own
        // try/catch so a generation failure never disturbs the sweep's recompute
        // bookkeeping (the subject stays recomputed; the proposal re-attempts).
        try {
          await this.trust.generateProposalsForSubject(
            s.subject_id,
            s.tenant_id,
            new Date(),
            'recompute_sweep',
          );
        } catch (genErr) {
          this.logger.warn({
            event: 'proposal_generation_failed',
            host: 'recompute_sweep',
            tenant_id: s.tenant_id,
            subject_id: s.subject_id,
            error: genErr instanceof Error ? genErr.message : String(genErr),
          });
        }
      } catch (err) {
        result.failed += 1;
        this.logger.warn({
          event: 'recompute_sweep_subject_failed',
          tenant_id: s.tenant_id,
          subject_id: s.subject_id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return result;
  }

  // The scheduled seam (the processor calls this; acceptance specs call it directly).
  async tick(): Promise<RecomputeSweepResult> {
    const result = await this.drainBatch({ batchSize: RECOMPUTE_SWEEP_BATCH_SIZE });
    this.logger.log({ event: 'recompute_sweep_tick_completed', ...result });
    return result;
  }

  // The manual CLI escape hatch: drain the time gate to completion (optionally
  // scoped to one tenant), reporting aggregate counts. Bounded — each recompute
  // advances last_recomputed_at past the threshold, so the pending set strictly
  // shrinks and an empty batch ends the loop.
  async runToCompletion(tenantId?: string): Promise<RecomputeSweepResult> {
    const total: RecomputeSweepResult = { attempted: 0, recomputed: 0, failed: 0 };
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const batch = await this.drainBatch({ batchSize: RECOMPUTE_SWEEP_BATCH_SIZE, tenantId });
      total.attempted += batch.attempted;
      total.recomputed += batch.recomputed;
      total.failed += batch.failed;
      // A batch of pure failures leaves those subjects un-advanced (recompute
      // threw), so they would re-select forever — stop when nothing was
      // attempted, or when a batch recomputed nothing (only failures remain).
      if (batch.attempted === 0 || batch.recomputed === 0) break;
    }
    return total;
  }
}
