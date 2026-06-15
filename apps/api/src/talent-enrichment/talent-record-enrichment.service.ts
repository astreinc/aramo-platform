import { Injectable } from '@nestjs/common';
import { ActivityRepository } from '@aramo/activity';
import { ConsentRepository, type ConsentSummary } from '@aramo/consent';
import { PipelineRepository } from '@aramo/pipeline';
import type { TalentRecordView } from '@aramo/talent-record';

// Segment 3 — the talent-records list READ-COMPOSER. Lives in apps/api (the
// only layer allowed to know all four modules); libs/talent-record stays
// single-schema and imports none of activity/consent/pipeline.
//
// HARD CONSTRAINT — BATCH, never loop: each enrichment is ONE set-based read
// over the page's id set (3 batched accessors run concurrently). A looped
// orchestration would just relocate the N+1 it kills — so this never iterates
// per row to fetch.
@Injectable()
export class TalentRecordEnrichmentService {
  constructor(
    private readonly activity: ActivityRepository,
    private readonly consent: ConsentRepository,
    private readonly pipeline: PipelineRepository,
  ) {}

  async enrich(
    items: readonly TalentRecordView[],
    ctx: {
      tenant_id: string;
      visible_requisition_ids: ReadonlySet<string> | null;
    },
  ): Promise<TalentRecordView[]> {
    if (items.length === 0) return [...items];

    const ids = items.map((i) => i.id);
    // consent is Core-keyed — only linked records can carry a grant.
    const coreIds = [
      ...new Set(
        items
          .map((i) => i.core_talent_id)
          .filter((x): x is string => x !== null),
      ),
    ];

    const [lastActivity, stages, consent] = await Promise.all([
      this.activity.findLastActivityForTalentIds({
        tenant_id: ctx.tenant_id,
        talent_record_ids: ids,
      }),
      this.pipeline.findCurrentStageForTalentIds({
        tenant_id: ctx.tenant_id,
        talent_record_ids: ids,
        visible_requisition_ids: ctx.visible_requisition_ids,
      }),
      coreIds.length > 0
        ? this.consent.findContactingConsentSummaryForTalentIds({
            tenant_id: ctx.tenant_id,
            talent_ids: coreIds,
          })
        : Promise.resolve(new Map<string, ConsentSummary>()),
    ]);

    return items.map((i) => ({
      ...i,
      last_activity_at: lastActivity.get(i.id) ?? null,
      current_stage: stages.get(i.id) ?? null,
      // Unlinked (no core_talent_id) or no contacting grant ⇒ do_not_contact
      // (no permission). Only a positive grant is contactable.
      consent_summary:
        i.core_talent_id !== null
          ? (consent.get(i.core_talent_id) ?? 'do_not_contact')
          : 'do_not_contact',
    }));
  }
}
