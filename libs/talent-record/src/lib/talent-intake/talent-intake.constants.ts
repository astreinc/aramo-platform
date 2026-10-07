// Durable Async Résumé-First Talent Intake — queue/event/job identities.
//
// Architecture: a résumé upload persists a TalentIntakeDraft + a transactional
// TalentIntakeOutboxEvent in ONE DB commit (the durable handoff boundary — no
// Redis dependency). A dedicated relay drains unpublished outbox rows and
// enqueues an idempotent BullMQ job onto the existing resume-extraction-draft
// queue; the worker CAS-claims the draft and runs ONE governed extraction.

// The intake extraction job rides the EXISTING resume-extraction-draft worker
// queue (so the dead-worker activation + the ATTACHMENT drain + the CREATE
// intake path are all driven by the same worker). Named job → intake handler.
export const TALENT_INTAKE_EXTRACT_JOB_NAME = 'intake-extract' as const;

// The relay runs on its own scheduled tick queue.
export const TALENT_INTAKE_RELAY_QUEUE_NAME = 'talent-intake-relay' as const;
export const TALENT_INTAKE_RELAY_BATCH_SIZE = 50 as const;

// Safety-net drain batch for QUEUED intake drafts the relay may not have
// enqueued (Redis down at commit time / relay lag) — processed on the worker
// tick alongside the ATTACHMENT drain.
export const TALENT_INTAKE_QUEUED_DRAIN_BATCH_SIZE = 25 as const;

// The transactional outbox event type for a requested résumé extraction.
export const TALENT_INTAKE_EXTRACTION_REQUESTED_EVENT =
  'talent_intake.resume_extraction_requested.v1' as const;

// The intake draft source_type.
export const TALENT_INTAKE_SOURCE_TYPE_RESUME_UPLOAD = 'RESUME_UPLOAD' as const;

// Deterministic BullMQ job id derived from the outbox event id — relay replay
// cannot create a duplicate expensive extraction job.
export function intakeExtractJobId(outboxEventId: string): string {
  return `${TALENT_INTAKE_EXTRACT_JOB_NAME}:${outboxEventId}`;
}
