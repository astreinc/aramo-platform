// Per-entry DTO for /consent/decision-log/{talent_id} (PR-7 §4).
//
// Field set is closed at exactly seven fields. The entry DTO is closed
// (additionalProperties: false at the OpenAPI surface); only
// `event_payload` is open (heterogeneous JSON pass-through).
//
// Field name mapping (PR-7 §5):
//   DB id          → API event_id   (PR-6 precedent)
//   DB subject_id  → API talent_id  (PR-7 exception, this directive)
//
// `event_type` is a closed set per PR-7 §7 + ADR-0009 §4 (audit/event-log
// table principle): {consent.grant.recorded, consent.revoke.recorded,
// consent.check.decision}. Adding a value requires a directive amendment.
//
// `actor_type` is a closed set: {recruiter, self, system}. Adding a value
// requires a directive amendment.
//
// `event_payload` is opaque JSON pass-through. The directive forbids
// extracting or transforming fields from inside the payload to populate
// top-level entry fields (§11 halt condition).

export type ConsentDecisionLogEventType =
  | 'consent.grant.recorded'
  | 'consent.revoke.recorded'
  | 'consent.check.decision';

export type ConsentDecisionLogActorType = 'recruiter' | 'self' | 'system';

export const CONSENT_DECISION_LOG_EVENT_TYPES: readonly ConsentDecisionLogEventType[] = [
  'consent.grant.recorded',
  'consent.revoke.recorded',
  'consent.check.decision',
];

export interface ConsentDecisionLogEntryDto {
  event_id: string;
  talent_id: string;
  event_type: ConsentDecisionLogEventType;
  created_at: string;
  actor_id: string | null;
  actor_type: ConsentDecisionLogActorType;
  event_payload: Record<string, unknown>;
}
