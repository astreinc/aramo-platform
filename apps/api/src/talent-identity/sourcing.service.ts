import { Injectable, Logger } from '@nestjs/common';
import { PipelineRepository } from '@aramo/pipeline';
import { SavedListRepository } from '@aramo/saved-list';
import type { SubjectRef } from '@aramo/talent-trust';

import { PromotionService, type PromotionOutcome } from './promotion.service.js';

// Promotion-Trigger slice-A — the two sourcer triggers, both promote-then-
// associate behind the identity gate (which lives in promoteSubject). apps/api
// orchestration above the I15 wall: reads cip talent-trust (via promoteSubject),
// writes ats talent-record / pipeline / saved-list. Idempotent on replay:
// promoteSubject no-ops an already-promoted subject; the pipeline
// @@unique([talent_record_id, requisition_id]) and the bench
// @@unique([saved_list_id, item_id]) no-op a duplicate association.
//
// A gate deferral (deferred_unresolved_identity / deferred_no_name / …) short-
// circuits: NO record is minted and NO association happens — the outcome carries
// the deferral status straight through.

export interface SourcingResult {
  status: PromotionOutcome['status'];
  talent_record_id?: string;
  // Present on a successful Add-to-Pipeline (the created pipeline row, or null
  // when the association already existed).
  pipeline_id?: string | null;
  // Present on a successful Save-to-Bench (the tenant bench list id).
  bench_id?: string;
}

@Injectable()
export class SourcingService {
  private readonly logger = new Logger(SourcingService.name);

  constructor(
    private readonly promotion: PromotionService,
    private readonly pipelines: PipelineRepository,
    private readonly savedLists: SavedListRepository,
  ) {}

  // Trigger 1 — Add to Pipeline: promote (gated) → associate the minted record
  // to the requisition. A gate deferral short-circuits (no mint, no pipeline).
  async promoteAndAddToPipeline(
    subjectRef: SubjectRef,
    requisitionId: string,
    opts?: { requestId?: string },
  ): Promise<SourcingResult> {
    const outcome = await this.promotion.promoteSubject(subjectRef, opts);
    if (!isPromoted(outcome)) return { status: outcome.status };

    const talent_record_id = outcome.talent_record_id;
    let pipeline_id: string | null = null;
    try {
      const pipeline = await this.pipelines.create({
        tenant_id: subjectRef.tenant_id,
        input: { talent_record_id, requisition_id: requisitionId },
      });
      pipeline_id = pipeline.id;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // Already in this pipeline — idempotent no-op (the @@unique held; the
      // requisition-openings decrement rolled back with the failed insert).
      this.logger.log(
        `promoteAndAddToPipeline: talent ${talent_record_id} already in requisition ${requisitionId} pipeline (no-op)`,
      );
    }
    return { status: outcome.status, talent_record_id, pipeline_id };
  }

  // Trigger 2 — Save to Pool: promote (gated) → add the minted record to the
  // tenant-shared sourcing bench. A gate deferral short-circuits.
  async promoteAndSaveToBench(
    subjectRef: SubjectRef,
    opts?: { requestId?: string },
  ): Promise<SourcingResult> {
    const outcome = await this.promotion.promoteSubject(subjectRef, opts);
    if (!isPromoted(outcome)) return { status: outcome.status };

    const talent_record_id = outcome.talent_record_id;
    const bench = await this.savedLists.getOrCreateTenantBench(subjectRef.tenant_id);
    await this.savedLists.addToTenantBench({
      tenant_id: subjectRef.tenant_id,
      bench_id: bench.id,
      talent_record_id,
    });
    return { status: outcome.status, talent_record_id, bench_id: bench.id };
  }
}

function isPromoted(
  o: PromotionOutcome,
): o is Extract<PromotionOutcome, { talent_record_id: string }> {
  return o.status === 'promoted' || o.status === 'already_promoted';
}

// Prisma unique-constraint violation (P2002) — the association already exists.
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'P2002'
  );
}
