// TIP-E2E INC-3 — the closed Technical Screening vocabulary
// (ARAMO-TIP-E2E-INC-3-v1.0-LOCKED §4/§5; basis per Aramo-TR-SCREEN-1-DDR-v1_0-LOCKED §2.1).
// Mirrored by the CHECK constraints in the init migration.

export const SCREENING_SESSION_STATES = ['DRAFT', 'CONFIRMED', 'VOIDED'] as const;
export type ScreeningSessionState = (typeof SCREENING_SESSION_STATES)[number];

export const SCREENING_BASES = ['SELF_REPORTED', 'RECRUITER_OBSERVED', 'DEMONSTRATED'] as const;
export type ScreeningBasis = (typeof SCREENING_BASES)[number];

export const SCREENING_PUBLICATION_STATES = ['PENDING', 'PUBLISHED', 'CONFLICT'] as const;
export type ScreeningPublicationState = (typeof SCREENING_PUBLICATION_STATES)[number];

export const SCREENING_EVENT_TYPES = [
  'SESSION_CREATED',
  'FINDING_ADDED',
  'FINDING_EDITED',
  'FINDING_REMOVED',
  'SESSION_CONFIRMED',
  'SESSION_VOIDED',
  'FINDING_PUBLISHED',
  'PUBLICATION_ATTEMPT_FAILED',
  'PUBLICATION_CONFLICT',
] as const;
export type ScreeningEventType = (typeof SCREENING_EVENT_TYPES)[number];

// Field bounds (deterministic validation; no AI).
export const SCREENING_SKILL_MAX = 200;
export const SCREENING_TEXT_MAX = 4000;
export const SCREENING_VOID_REASON_MAX = 1000;
