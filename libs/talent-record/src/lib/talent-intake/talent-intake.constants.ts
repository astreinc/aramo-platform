// Durable Async Résumé-First Talent Intake — event identities (ADR-0033).
//
// Architecture: a source admission persists a TalentIntakeDraft + a
// transactional TalentIntakeOutboxEvent in ONE DB commit (the durable handoff
// boundary — no Redis dependency). The lease-safe outbox publisher drains
// unpublished rows and publishes the canonical envelope to EventBridge; a
// consumer-owned SQS queue + Lambda run the governed extraction. (The former
// BullMQ relay/queue/job transport was retired at the ADR-0033 cutover.)

// The transactional outbox event type for a requested résumé extraction.
export const TALENT_INTAKE_EXTRACTION_REQUESTED_EVENT =
  'talent_intake.resume_extraction_requested.v1' as const;

// The canonical envelope `source` (producing service) for intake events — the
// EventBridge rule routes on `<sourcePrefix>.<source>`; the handler validates it.
export const TALENT_INTAKE_EVENT_SOURCE = 'talent-intake' as const;

// Canonical envelope metadata for intake extraction-requested events.
export const TALENT_INTAKE_EVENT_VERSION = 'v1' as const;
export const TALENT_INTAKE_SUBJECT_TYPE = 'talent_intake_draft' as const;

// The intake draft source_type.
export const TALENT_INTAKE_SOURCE_TYPE_RESUME_UPLOAD = 'RESUME_UPLOAD' as const;
