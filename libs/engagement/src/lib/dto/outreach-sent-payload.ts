// M5 PR-6 §4.2 — typed event_payload shape for TalentEngagementEvent
// rows of event_type='outreach_sent' (Ruling 5).
//
// Extended by the Outreach Draft/Preview Directive v1.0 / Amendment v1.1
// §2 with the editable-trail fields (final_text + source_draft_event_id).
// Under the draft→preview→send split, the outreach_sent event is appended
// at SEND and carries the text that was ACTUALLY sent (which may differ
// from the AI draft if the recruiter edited it) plus a back-reference to
// the source outreach_drafted event. Together with the persisted
// outreach_drafted.draft_text this makes the drafted≠sent trail provable.
//
// Fields:
//   - ai_draft_audit_record_id: links the engagement-event row to its
//     ai_draft.AiDraftEvent audit trail (M5 PR-5 substrate). Lets
//     auditors trace from outreach → LLM call.
//   - model_used: the concrete model id returned by the provider.
//   - input_tokens / output_tokens: token usage reported by the
//     provider.
//   - duration_ms: end-to-end LLM call duration (AiDraftService start →
//     stop).
//   - delivered_at: ISO-8601 timestamp the DeliveryProvider emitted.
//   - delivery_channel: closed-list channel discriminant. PR-6 only
//     emits 'email'.
//   - delivery_id: the synthetic delivery identifier from the provider
//     (SendStub at PR-6).
//   - final_text: the text actually delivered (the recruiter-approved,
//     possibly-edited draft). NEW — the sent half of the editable trail.
//   - source_draft_event_id: the outreach_drafted event this send was
//     produced from. NEW — links sent → drafted.
//
// Stored as Postgres jsonb in event_payload. The TalentEngagementEvent
// view typing (event_payload: unknown) is narrowed at consumption sites
// (per M5 PR-2 design).

export interface OutreachSentPayload {
  ai_draft_audit_record_id: string;
  model_used: string;
  input_tokens: number;
  output_tokens: number;
  duration_ms: number;
  delivered_at: string;
  delivery_channel: 'email';
  delivery_id: string;
  final_text: string;
  source_draft_event_id: string;
}
