// CI-B3 — provider-neutral transcript domain enums (directive §5/§7/§20).
// These mirror the Prisma enum value sets exactly (single source of the token
// vocabulary for the domain/service layer). No vendor terminology appears
// here — provider-specific names terminate at adapter boundaries.

/**
 * Transcript lifecycle states (directive §20). B3 owns the ACQUISITION states;
 * CI-B4 ADDITIVELY appends the NORMALIZATION states (add-only, mirrors the
 * Prisma enum). Acquisition and normalization failure states are kept SEPARATE
 * so the state carries the failing phase.
 */
export const TRANSCRIPT_STATES = [
  // Acquisition (CI-B3).
  'waiting_for_source',
  'source_available',
  'acquiring',
  'source_ready',
  'expired',
  'failed_retryable',
  'intervention_required',
  'failed_terminal',
  // Normalization (CI-B4).
  'normalizing',
  'normalized',
  'normalization_failed_retryable',
  'normalization_intervention_required',
  'normalization_failed_terminal',
] as const;
export type TranscriptState = (typeof TRANSCRIPT_STATES)[number];

/**
 * Canonical speaker role vocabulary for the NORMALIZED transcript artifact
 * (directive §9). Closed set. B4 NEVER infers a role from a provider display
 * name — an unresolved speaker is UNKNOWN.
 */
export const TRANSCRIPT_SPEAKER_ROLES = [
  'RECRUITER',
  'TALENT',
  'OTHER',
  'UNKNOWN',
] as const;
export type TranscriptSpeakerRole = (typeof TRANSCRIPT_SPEAKER_ROLES)[number];

/** Content custody modes (directive §7.3). */
export const TRANSCRIPT_CUSTODY_MODES = [
  'provider_referenced',
  'temporarily_cached',
  'aramo_retained',
] as const;
export type TranscriptCustodyMode = (typeof TRANSCRIPT_CUSTODY_MODES)[number];

/** Source artifact class (directive §5 capability model). */
export const TRANSCRIPT_SOURCE_TYPES = [
  'provider_full_transcript',
  'provider_live_stream',
  'unknown',
] as const;
export type TranscriptSourceType = (typeof TRANSCRIPT_SOURCE_TYPES)[number];

/** Provider-declared recording dependency (directive §4.3/§6.2 — NOT global). */
export const TRANSCRIPT_RECORDING_DEPENDENCIES = [
  'required',
  'not_required',
  'unknown',
] as const;
export type TranscriptRecordingDependency =
  (typeof TRANSCRIPT_RECORDING_DEPENDENCIES)[number];
