// COMM-V1 — provider-neutral domain enums (COMM-B1). These are the program-side
// mirrors of the Prisma enums in libs/communications/prisma/schema.prisma. NO
// vendor vocabulary appears here — the domain is provider-neutral; any provider
// terminology is confined to the provider adapter.

/** The medium of an interaction. `voice` executes in COMM-V1; sms/email carried by design. */
export const COMMUNICATION_CHANNELS = ['voice', 'sms', 'email'] as const;
export type CommunicationChannel = (typeof COMMUNICATION_CHANNELS)[number];

/** Direction of an interaction. Outbound is the COMM-V1 target. */
export const COMMUNICATION_DIRECTIONS = ['outbound', 'inbound'] as const;
export type CommunicationDirection = (typeof COMMUNICATION_DIRECTIONS)[number];

/**
 * The canonical call state set (directive domain substrate). Provider
 * terminology normalizes INTO these; it never escapes the adapter. `canceled`/
 * `busy` are DEFERRED to COMM-B6 (admitted only if provider recon confirms).
 */
export const COMMUNICATION_INTERACTION_STATES = [
  'created',
  'initiated',
  'ringing',
  'connected',
  'completed',
  'failed',
  'missed',
  'rejected',
] as const;
export type CommunicationInteractionStatus = (typeof COMMUNICATION_INTERACTION_STATES)[number];

/** Polymorphic association subjects (subject_id is a UUID-only cross-schema ref). */
export const COMMUNICATION_SUBJECT_TYPES = ['talent_record', 'requisition', 'pipeline'] as const;
export type CommunicationSubjectType = (typeof COMMUNICATION_SUBJECT_TYPES)[number];

/** How an interaction relates to a subject. `regarding` (e.g. requisition) is OPTIONAL. */
export const COMMUNICATION_RELATION_TYPES = ['subject', 'regarding'] as const;
export type CommunicationRelationType = (typeof COMMUNICATION_RELATION_TYPES)[number];

/**
 * LOCKED v1 disposition vocabulary (directive). Implementation MUST NOT invent
 * values. `do_not_contact` is a RECORDED outcome ONLY — it does not auto-mutate
 * consent in V1 (governed workflow deferred).
 */
export const COMMUNICATION_DISPOSITION_OUTCOMES = [
  'connected',
  'left_voicemail',
  'no_answer',
  'busy',
  'wrong_number',
  'interested',
  'not_interested',
  'callback_requested',
  'follow_up_required',
  'do_not_contact',
] as const;
export type CommunicationDispositionOutcome = (typeof COMMUNICATION_DISPOSITION_OUTCOMES)[number];

/** The durable idempotent provider-event inbox disposition (R-COMM-WEBHOOK). */
export const COMMUNICATION_PROVIDER_EVENT_STATUSES = [
  'received',
  'processing',
  'processed',
  'failed',
  'ignored',
] as const;
export type CommunicationProviderEventStatus =
  (typeof COMMUNICATION_PROVIDER_EVENT_STATUSES)[number];

/** Recruiter<->provider mapping lifecycle. */
export const COMMUNICATION_PROVIDER_IDENTITY_STATUSES = [
  'active',
  'unmapped',
  'disabled',
  'reauth_required',
] as const;
export type CommunicationProviderIdentityStatus =
  (typeof COMMUNICATION_PROVIDER_IDENTITY_STATUSES)[number];
