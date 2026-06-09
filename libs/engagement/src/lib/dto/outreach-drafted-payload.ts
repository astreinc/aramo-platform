// Outreach Draft/Preview Directive v1.0 / Amendment v1.1 §1+§2 — typed
// event_payload shape for TalentEngagementEvent rows of
// event_type='outreach_drafted'.
//
// Appended by POST /v1/engagements/{id}/outreach/draft. Represents a
// PENDING, NOT-yet-delivered AI draft the recruiter reviews (and may
// edit) before SEND. NO delivery / outbox / state-transition is
// associated with this event.
//
// Fields:
//   - draft_text: the AI-generated completion (generateDraft().completion).
//     This is the FIRST place outreach text is persisted (per the
//     ADR-0015 addendum — the engagement event log persists outreach
//     text; libs/ai-draft stays hash-only per ADR-0015 Decision 5).
//   - ai_draft_audit_record_id: links this draft to its
//     ai_draft.AiDraftEvent audit trail (forensic traceability draft →
//     LLM call).
//   - model_used / input_tokens / output_tokens / duration_ms: the
//     provider call accounting, mirrored from GenerateDraftResult.
//   - prompt / max_tokens / system_message: the generation inputs,
//     retained for audit (what was asked of the model).
//   - recipient_handle: optional opaque correlation handle the caller
//     attached at draft time (recipient resolution deferred — substrate
//     does not look up contact rows).
//
// Stored as Postgres jsonb in event_payload; narrowed at consumption.
export interface OutreachDraftedPayload {
  draft_text: string;
  ai_draft_audit_record_id: string;
  model_used: string;
  input_tokens: number;
  output_tokens: number;
  duration_ms: number;
  prompt: string;
  max_tokens: number;
  system_message?: string;
  recipient_handle?: string;
}
