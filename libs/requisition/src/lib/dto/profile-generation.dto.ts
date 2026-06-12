import type { GoldenProfileContent } from '@aramo/job-domain';

import type { RequisitionView } from './requisition.view.js';

// Job-Module LB-3 — JD + GoldenProfile generation DTOs (draft → confirm,
// mirroring the engagement draft → send two-endpoint pattern; ADR-0015 v1.2
// G1). The draft is non-committal (no mutation of the canonical
// Requisition / GoldenProfile); the confirm persists the recruiter-
// reviewed final.

// POST /v1/requisitions/:id/profile/draft
export interface DraftProfileRequestDto {
  brief: string;
  max_tokens?: number;
}

export interface DraftProfileResponseDto {
  // The ai_draft audit record id (the draft's reference; confirm echoes it
  // back as the cross-event-ref). The draft's prompt/model/tokens are
  // persisted in the libs/ai-draft event log under this id (G2).
  draft_event_id: string;
  jd_text: string;
  golden_profile_draft: GoldenProfileContent;
  ai_draft_audit_record_id: string;
}

// POST /v1/requisitions/:id/profile/confirm
export interface ConfirmProfileRequestDto {
  // The draft this confirm derives from. REQUIRED when the profile was
  // AI-generated (generated_by === 'ai_draft') — the cross-event-ref
  // (mirrors the engagement send referencing its draft event). OPTIONAL for the
  // manual-entry path (generated_by === 'manual') — AI is assistive, never
  // required (G1).
  draft_event_id?: string;
  jd_text: string;
  golden_profile: GoldenProfileContent;
}

// Confirm returns the updated requisition view (golden_profile_id stamped).
export type ConfirmProfileResponseDto = RequisitionView;
