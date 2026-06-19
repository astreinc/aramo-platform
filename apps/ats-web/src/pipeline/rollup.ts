// Per-requisition pipeline rollup — the single home for the "Pipeline" and
// "Submitted" counts the Requisitions list and the My-desk table both render.
// Derived from an unfiltered /v1/pipelines call (every pipeline across the
// actor's visible requisitions); grouped by requisition_id client-side so the
// surfaces share ONE call, not N+1, and can never drift on the bucket rules.

import { funnelBucket } from '../ui';

import { CLOSED_STATUSES, type PipelineStatus, type PipelineView } from './types';

export interface ReqPipelineCount {
  // Active = pipelines still moving (not at a terminal stage).
  readonly active: number;
  // Submitted = pipelines that reached the Submitted funnel bucket or beyond
  // (submitted / interview / offer / placed).
  readonly submitted: number;
}

const TERMINAL = new Set<PipelineStatus>(CLOSED_STATUSES);
const SUBMITTED_PLUS = new Set(['submitted', 'interview', 'offer', 'placed']);

export function rollupByRequisition(
  pipelines: readonly PipelineView[],
): Record<string, ReqPipelineCount> {
  const byReq: Record<string, ReqPipelineCount> = {};
  for (const p of pipelines) {
    const cur = byReq[p.requisition_id] ?? { active: 0, submitted: 0 };
    byReq[p.requisition_id] = {
      active: cur.active + (TERMINAL.has(p.status) ? 0 : 1),
      submitted:
        cur.submitted + (SUBMITTED_PLUS.has(funnelBucket(p.status)) ? 1 : 0),
    };
  }
  return byReq;
}
