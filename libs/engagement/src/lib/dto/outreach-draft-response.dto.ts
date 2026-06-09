// Outreach Draft/Preview Directive v1.0 / Amendment v1.1 §1 — HTTP
// response DTO for POST /v1/engagements/{id}/outreach/draft.
//
// Returns the generated draft text + the id of the persisted
// outreach_drafted event (which SEND later references via
// draft_event_id) + the ai_draft audit linkage.
//
//   - draft_event_id: the TalentEngagementEvent id of the appended
//     outreach_drafted row. The recruiter posts this back to
//     POST .../outreach/send.
//   - draft_text: the AI-generated completion the recruiter reviews/edits.
//   - ai_draft_audit_record_id: the ai_draft.AiDraftEvent linkage.
//   - consent_warning: OPTIONAL, non-blocking (Amendment v1.1 Ruling 1).
//     Present only when the soft consent pre-check returned 'denied' at
//     draft time. It is INFORMATIONAL — drafting still succeeded; the
//     BINDING consent gate (403 CONSENT_NOT_GRANTED_AT_SEND) fires at
//     SEND, not here. Carries the denial reason so the FE can warn the
//     recruiter before they invest in editing.

export interface OutreachDraftConsentWarning {
  reason_code?: string;
  display_message?: string;
}

export interface OutreachDraftResponseDto {
  draft_event_id: string;
  draft_text: string;
  ai_draft_audit_record_id: string;
  consent_warning?: OutreachDraftConsentWarning;
}
