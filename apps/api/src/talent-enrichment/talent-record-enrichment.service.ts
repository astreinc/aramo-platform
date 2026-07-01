import { Injectable } from '@nestjs/common';
import { ActivityRepository } from '@aramo/activity';
import { ConsentRepository, type ConsentSummary } from '@aramo/consent';
import { PipelineRepository } from '@aramo/pipeline';
import { TalentRecordRepository } from '@aramo/talent-record';
import type {
  CrossFacets,
  TalentRecordView,
  TalentSearchQuery,
} from '@aramo/talent-record';

// Segment 4b — the materialize guard. Beyond this many MATCHED ids, a
// cross-schema facet count would force a large in-app materialization, so we
// stop and ask the user to narrow (no silent perf cliff). Configurable.
const DEFAULT_XFACET_GUARD = 5000;
function xfacetGuard(): number {
  const raw = process.env['TALENT_XFACET_GUARD'];
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_XFACET_GUARD;
}

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
    private readonly talent: TalentRecordRepository,
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
      // Step-5 consent re-key: consent is now keyed by TalentRecord.id (i.id) —
      // no Core hop / core_talent_id filter. items.length > 0 guarded above.
      this.consent.findContactingConsentSummaryForTalentIds({
        tenant_id: ctx.tenant_id,
        talent_record_ids: ids,
      }),
    ]);

    return items.map((i) => ({
      ...i,
      last_activity_at: lastActivity.get(i.id) ?? null,
      current_stage: stages.get(i.id) ?? null,
      // Keyed by TalentRecord.id; no contacting grant ⇒ do_not_contact (only a
      // positive grant is contactable).
      consent_summary: consent.get(i.id) ?? 'do_not_contact',
    }));
  }

  // Segment 4b — FULL-SET cross-schema facet counts (recency / consent / stage)
  // for the *entire* native-filtered match set, not just the loaded page.
  //
  // ISOLATION: libs/talent-record resolves the matched key set against its own
  // columns (findFilteredKeys — single-schema), then we run the SAME Seg-3
  // batch accessors over those ids. Never a cross-schema join/subquery.
  //
  // GUARD: bounded by xfacetGuard(). findFilteredKeys takes `guard` as its
  // limit and returns up to guard+1 — if it overflows, we DON'T materialize the
  // cross-schema reads; we return over_guard so the UI asks the user to narrow.
  async crossFacets(
    query: TalentSearchQuery,
    ctx: {
      tenant_id: string;
      visible_requisition_ids: ReadonlySet<string> | null;
    },
  ): Promise<CrossFacets> {
    const guard = xfacetGuard();
    const keys = await this.talent.findFilteredKeys(query, guard);

    if (keys.length > guard) {
      return {
        over_guard: true,
        matched: guard + 1, // sentinel: "more than guard"
        guard,
        recency: { today: 0, '7d': 0, '30d': 0, stale: 0 },
        consent: [],
        stage: [],
      };
    }

    const ids = keys.map((k) => k.id);

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
      // Step-5 consent re-key: consent keyed by TalentRecord.id (k.id).
      ids.length > 0
        ? this.consent.findContactingConsentSummaryForTalentIds({
            tenant_id: ctx.tenant_id,
            talent_record_ids: ids,
          })
        : Promise.resolve(new Map<string, ConsentSummary>()),
    ]);

    // recency — cumulative tiers mirroring the FE: today ⊆ 7d ⊆ 30d. `stale`
    // = no activity in ≥90d OR never. The 31–89d band is deliberately in no
    // chip (active-but-aging), so it falls through every branch.
    const now = Date.now();
    const recency = { today: 0, '7d': 0, '30d': 0, stale: 0 };
    for (const id of ids) {
      const ts = lastActivity.get(id);
      if (ts === undefined) {
        recency.stale++;
        continue;
      }
      const days = Math.floor((now - new Date(ts).getTime()) / 86_400_000);
      if (days >= 90) {
        recency.stale++;
        continue;
      }
      if (days <= 30) recency['30d']++;
      if (days <= 7) recency['7d']++;
      if (days <= 0) recency.today++;
    }

    // consent — same do_not_contact-by-default rule as enrich(): no positive
    // contacting grant ⇒ do_not_contact. Keyed by TalentRecord.id (k.id).
    const consentCounts = new Map<string, number>();
    for (const k of keys) {
      const summary = consent.get(k.id) ?? 'do_not_contact';
      consentCounts.set(summary, (consentCounts.get(summary) ?? 0) + 1);
    }

    // stage — current active stage label; 'none' when not in any active flow.
    const stageCounts = new Map<string, number>();
    for (const id of ids) {
      const value = stages.get(id)?.stage ?? 'none';
      stageCounts.set(value, (stageCounts.get(value) ?? 0) + 1);
    }

    const toBuckets = (m: Map<string, number>) =>
      [...m.entries()].map(([value, count]) => ({ value, count }));

    return {
      over_guard: false,
      matched: keys.length,
      guard,
      recency,
      consent: toBuckets(consentCounts),
      stage: toBuckets(stageCounts),
    };
  }
}
