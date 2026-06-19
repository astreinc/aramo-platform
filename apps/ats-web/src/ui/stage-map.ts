// Stage tint + funnel-bucket mapping for the pipeline.
//
// Single source of truth for the recruiter-facing PIPELINE STATUS model is
// ../pipeline/types.ts (R1's hand-mirror of libs/pipeline, drift-guarded by
// legal-transitions-drift.spec.ts). This module adds only the PRESENTATIONAL
// projections the Confident Blue design system needs: a per-status colour
// tone (for StagePill) and the 6-bucket funnel aggregation the mockup's
// pipeline ribbon renders. It introduces no new domain facts — it re-projects
// the existing 11-state enum, and stage-map.spec.ts asserts exhaustiveness so
// a new BE status can never silently fall through.

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

// STAGE-PILL SEMANTICS (Lead directive):
//   Sourced/Contacted = neutral · Qualifying/Interview = info ·
//   Submitted = brand · Offer = warn · Placed = ok · Rejected/Withdrawn = danger
const STAGE_TONE: Record<PipelineStatus, StageTone> = {
  no_status: 'neutral',
  no_contact: 'neutral', // "Sourced" bucket
  contacted: 'neutral',
  talent_responded: 'info',
  qualifying: 'info',
  submitted: 'brand',
  interviewing: 'info', // "Interview" bucket
  offered: 'warn', // "Offer" bucket
  not_in_consideration: 'danger',
  client_declined: 'danger',
  placed: 'ok',
};

export function stageTone(status: PipelineStatus): StageTone {
  return STAGE_TONE[status];
}

export function stageLabel(status: PipelineStatus): string {
  return PIPELINE_STATUS_LABELS[status];
}

// The 6-bucket funnel the pipeline ribbon renders. Each bucket aggregates the
// 11-state machine; terminal/legacy states fold into the trailing buckets.
export const FUNNEL_BUCKETS = [
  { key: 'sourced', label: 'Sourced' },
  { key: 'qualifying', label: 'Qualifying' },
  { key: 'submitted', label: 'Submitted' },
  { key: 'interview', label: 'Interview' },
  { key: 'offer', label: 'Offer' },
  { key: 'placed', label: 'Placed' },
] as const;

export type FunnelBucketKey = (typeof FUNNEL_BUCKETS)[number]['key'];

const STATUS_TO_BUCKET: Record<PipelineStatus, FunnelBucketKey> = {
  no_status: 'sourced',
  no_contact: 'sourced',
  contacted: 'sourced',
  talent_responded: 'qualifying',
  qualifying: 'qualifying',
  submitted: 'submitted',
  interviewing: 'interview',
  offered: 'offer',
  not_in_consideration: 'sourced', // terminal-reject: counted out of the active funnel
  client_declined: 'submitted',
  placed: 'placed',
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
