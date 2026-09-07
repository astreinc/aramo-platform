// CI-B3 — provider-neutral transcript domain enums (directive §5/§7/§20).
// These mirror the Prisma enum value sets exactly (single source of the token
// vocabulary for the domain/service layer). No vendor terminology appears
// here — provider-specific names terminate at adapter boundaries.

/** Acquisition lifecycle states (directive §20). B3 owns acquisition only. */
export const TRANSCRIPT_STATES = [
  'waiting_for_source',
  'source_available',
  'acquiring',
  'source_ready',
  'expired',
  'failed_retryable',
  'intervention_required',
  'failed_terminal',
] as const;
export type TranscriptState = (typeof TRANSCRIPT_STATES)[number];

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
