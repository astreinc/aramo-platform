// Stage tint + funnel-bucket mapping for the pipeline.
//
// Single source of truth for the recruiter-facing PIPELINE STATUS model is
// ../pipeline/types.ts (R1's hand-mirror of libs/pipeline, drift-guarded by
// legal-transitions-drift.spec.ts). This module adds only the PRESENTATIONAL
// projections the Confident Blue design system needs: a per-status colour
// tone (for StagePill) and the pipeline-owned funnel aggregation the ribbon
// renders. It introduces no new domain facts — it re-projects the canonical
// 7-state enum, and stage-map.spec.ts asserts exhaustiveness so a new BE status
// can never silently fall through.

import {
  PIPELINE_STATUS_LABELS,
  PIPELINE_STATUS_VALUES,
  type PipelineStatus,
} from '../pipeline/types';

export type StageTone =
  | 'neutral'
  | 'info'
  | 'brand'
  | 'warn'
  | 'ok'
  | 'danger';

// STAGE-PILL SEMANTICS: Sourced/Contacted = neutral · Responded/Qualifying/
// Qualified = info · Completed = ok · Not-in-consideration = danger.
const STAGE_TONE: Record<PipelineStatus, StageTone> = {
  no_contact: 'neutral', // "Sourced" bucket
  contacted: 'neutral',
  talent_responded: 'info',
  qualifying: 'info',
  qualified: 'info', // affirmative milestone, still an active "Qualifying" tone
  not_in_consideration: 'danger',
  completed: 'ok', // canonical success terminal
};

export function stageTone(status: PipelineStatus): StageTone {
  return STAGE_TONE[status];
}

export function stageLabel(status: PipelineStatus): string {
  return PIPELINE_STATUS_LABELS[status];
}

// The pipeline-owned funnel the ribbon renders. Each bucket aggregates the
// canonical 7-state machine. The Pipeline owns recruiting progress only —
// downstream stages (submittal / interview / offer / placement) are NOT Pipeline
// buckets; they are shown from their owning aggregates elsewhere. `closed` is a UI
// aggregation of the two canonical terminals, NOT a Pipeline status.
export const FUNNEL_BUCKETS = [
  { key: 'early_engagement', label: 'Early engagement' },
  { key: 'qualifying', label: 'Qualifying' },
  { key: 'qualified', label: 'Qualified' },
  { key: 'closed', label: 'Closed' },
] as const;

export type FunnelBucketKey = (typeof FUNNEL_BUCKETS)[number]['key'];

const STATUS_TO_BUCKET: Record<PipelineStatus, FunnelBucketKey> = {
  no_contact: 'early_engagement',
  contacted: 'early_engagement',
  talent_responded: 'qualifying',
  qualifying: 'qualifying',
  qualified: 'qualified', // the affirmative recruiter milestone
  not_in_consideration: 'closed', // disposition terminal
  completed: 'closed', // canonical success terminal
};

export function funnelBucket(status: PipelineStatus): FunnelBucketKey {
  return STATUS_TO_BUCKET[status];
}

// Aggregate a list of statuses into ordered {label, count} funnel cells.
export function funnelCounts(
  statuses: readonly PipelineStatus[],
): readonly { key: FunnelBucketKey; label: string; count: number }[] {
  const tally = new Map<FunnelBucketKey, number>();
  for (const s of statuses) {
    const b = funnelBucket(s);
    tally.set(b, (tally.get(b) ?? 0) + 1);
  }
  return FUNNEL_BUCKETS.map((b) => ({
    key: b.key,
    label: b.label,
    count: tally.get(b.key) ?? 0,
  }));
}

// Re-export for convenience so consumers can iterate the enum without a
// second import.
export { PIPELINE_STATUS_VALUES };
export type { PipelineStatus };
