import { Inject, Injectable, type LoggerService } from '@nestjs/common';
import { TalentTrustRepository, TalentTrustService } from '@aramo/talent-trust';

import { RECOMPUTE_REPAIR_BATCH_SIZE } from './recompute-repair.queue.constants.js';

// G1 (directive §3.3) — the recomputation-repair drain. Each pending request is
// recomputed through the normal path (which resolves the ACTIVE SURVIVOR, takes
// the per-cluster lock, reads a tenant-bound snapshot and clears only the
// requests it covers). A failure leaves the request pending and moves it to the
// back of the queue (back-off); it is never cleared on failure. Idempotent: a
// repeated or overlapping repair of the same cluster serializes on the lock and
// re-derives the same state from the committed ledger.

export interface RecomputeRepairResult {
  attempted: number;
  repaired: number;
  failed: number;
}

@Injectable()
export class RecomputeRepairService {
  constructor(
    private readonly repo: TalentTrustRepository,
    private readonly trust: TalentTrustService,
    @Inject('RecomputeRepairServiceLogger') private readonly logger: LoggerService,
  ) {}

  async drainBatch(args: { batchSize: number; tenantId?: string }): Promise<RecomputeRepairResult> {
    const pending = await this.repo.listSubjectsRequestingRecompute(args.batchSize, args.tenantId);
    const result: RecomputeRepairResult = { attempted: pending.length, repaired: 0, failed: 0 };
    for (const p of pending) {
      try {
        await this.trust.recomputeTrustState(p.subject_id, p.tenant_id);
        result.repaired += 1;
      } catch (err) {
        result.failed += 1;
        await this.repo.deferRecomputeRequest(p.subject_id, p.tenant_id).catch(() => undefined);
        this.logger.warn({
          event: 'trust_recompute_repair_failed',
          subject_id: p.subject_id,
          tenant_id: p.tenant_id,
          error_message: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return result;
  }

  async tick(): Promise<RecomputeRepairResult> {
    const result = await this.drainBatch({ batchSize: RECOMPUTE_REPAIR_BATCH_SIZE });
    if (result.attempted > 0) this.logger.log({ event: 'trust_recompute_repair_tick_completed', ...result });
    return result;
  }
}
