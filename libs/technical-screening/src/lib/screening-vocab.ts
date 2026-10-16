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
  // INC-3 A1 §B.5.
  'QUESTION_PLAN_GENERATED',
  'QUESTION_EDITED',
  'QUESTION_SELECTION_CHANGED',
  'MEETING_LINKED',
  'NOTE_ADDED',
  'SUGGESTION_GENERATED',
  'SUGGESTION_ACTIONED',
  'TRANSCRIPT_LINKED',
  'FINDINGS_DRAFTED',
  'FINDING_REVIEWED',
] as const;
export type ScreeningEventType = (typeof SCREENING_EVENT_TYPES)[number];

// INC-3 A1 §B.2 — finding provenance axes.
export const FINDING_ORIGINS = ['RECRUITER_AUTHORED', 'AI_DRAFTED'] as const;
export type FindingOrigin = (typeof FINDING_ORIGINS)[number];
export const FINDING_REVIEW_STATUSES = ['DRAFT', 'EDITED', 'CONFIRMED', 'REJECTED'] as const;
export type FindingReviewStatus = (typeof FINDING_REVIEW_STATUSES)[number];
export const FINDING_EVIDENCE_SOURCES = ['RECRUITER_OBSERVATION', 'MEETING_TRANSCRIPT', 'RECRUITER_NOTES'] as const;
export type FindingEvidenceSource = (typeof FINDING_EVIDENCE_SOURCES)[number];

// INC-3 A1 §B.3/§B.4 — question plan and assistance vocabularies.
export const QUESTION_INTENTS = ['PROBE', 'FOLLOW_UP'] as const;
export const QUESTION_ORIGINS = ['AI_GENERATED', 'RECRUITER_AUTHORED'] as const;
export const QUESTION_STATUSES = ['PROPOSED', 'SELECTED', 'REMOVED'] as const;
export type QuestionStatus = (typeof QUESTION_STATUSES)[number];
export const AI_GENERATION_KINDS = ['QUESTION_PLAN', 'FOLLOW_UP', 'FINDINGS_DRAFT'] as const;
export type AiGenerationKind = (typeof AI_GENERATION_KINDS)[number];
export const SUGGESTION_ACTIONS = ['USED', 'DISMISSED'] as const;
export type SuggestionAction = (typeof SUGGESTION_ACTIONS)[number];
export const TRANSCRIPT_LINK_SOURCES = ['TEAMS_GRAPH', 'EXTERNAL_PROVIDER'] as const;
export type TranscriptLinkSource = (typeof TRANSCRIPT_LINK_SOURCES)[number];

export const SCREENING_QUESTION_MAX = 1000;
export const SCREENING_NOTE_MAX = 4000;
export const SCREENING_QUESTIONS_PER_SESSION_MAX = 40;

// Field bounds (deterministic validation; no AI).
export const SCREENING_SKILL_MAX = 200;
export const SCREENING_TEXT_MAX = 4000;
export const SCREENING_VOID_REASON_MAX = 1000;
