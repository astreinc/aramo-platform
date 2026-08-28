import type { PipelineDispositionAuthority } from '../pipeline-disposition.js';

// PipelineActionRequestDto — POST /v1/pipelines/:id/actions payload (L2-C SB-8).
//
// `action` is a recruiter named action (CONTACT / MARK_RESPONDED /
// START_QUALIFICATION / QUALIFY / DISPOSITION). The controller rejects the
// system-only COMPLETE with 422 VALIDATION_ERROR (§5) and any unknown action with
// 422. DISPOSITION requires `authority_class` + `reason` (a RECRUITER/TALENT/
// ENGAGEMENT taxonomy pair; a DOWNSTREAM_OUTCOME authority is refused here).
//
// The surface is deliberately NOT idempotency-gated (PO ruling): CAS on
// `expected_version` (→ PIPELINE_TRANSITION_CONFLICT on a stale replay), the no-op
// guard, and the UNIQUE(pipeline_id) disposition invariant are the duplicate-effect
// controls for a state-transition command.
export interface PipelineActionRequestDto {
  action: string;
  // Optimistic-concurrency token (REQUIRED). Missing/non-numeric → 422.
  expected_version: number;
  reason?: string;
  note?: string;
  authority_class?: PipelineDispositionAuthority;
}
