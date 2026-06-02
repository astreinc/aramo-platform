import type { PipelineStatus } from '../pipeline-state.js';

// TransitionPipelineRequestDto — POST /v1/pipelines/:id/transition payload.
// `to_status` is the proposed next state; the application-layer state
// machine (libs/pipeline/src/lib/pipeline-state.ts canTransition) decides
// whether the transition is legal from the current state. Illegal →
// 422 INVALID_PIPELINE_TRANSITION (the load-bearing refusal of A5a).
export interface TransitionPipelineRequestDto {
  to_status: PipelineStatus;
  note?: string;
}
