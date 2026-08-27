import type { PipelineStatus } from '../pipeline-state.js';

// TransitionPipelineRequestDto — POST /v1/pipelines/:id/transition payload.
// `to_status` is the proposed next state; the application-layer state
// machine (libs/pipeline/src/lib/pipeline-state.ts canTransition) decides
// whether the transition is legal from the current state. Illegal →
// 422 INVALID_PIPELINE_TRANSITION (the load-bearing refusal of A5a).
export interface TransitionPipelineRequestDto {
  to_status: PipelineStatus;
  note?: string;
  // Optimistic-concurrency token (Lane 2 / L2-A). REQUIRED — the value the
  // caller last read on the PipelineView. If it does not match the row's current
  // version (a concurrent transition already advanced it) the write is refused
  // with PIPELINE_TRANSITION_CONFLICT (409) and nothing is written. A missing
  // value is rejected at the controller boundary (422), never treated as 0.
  expected_version: number;
}
