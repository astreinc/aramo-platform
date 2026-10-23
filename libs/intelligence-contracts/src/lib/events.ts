// ATI-SEP-1 / ADR-0036 Decision 3 — business-fact event names (Addendum A2).
// ATS → TI: what happened to a TalentRecord. TI → ATS: the Golden profile moved.

/** Envelope version carried on every event in both directions. */
export const EVENT_VERSION = 'v1' as const;
export type EventVersion = typeof EVENT_VERSION;

/** The ATS is the first (and today the only) source system TI ingests from. */
export const SOURCE_SYSTEM_ARAMO_ATS = 'ARAMO_ATS' as const;
/** Closed list of source systems TI admits (the ingestion validator enforces it). */
export const SOURCE_SYSTEM_IDS = [SOURCE_SYSTEM_ARAMO_ATS] as const;
export type SourceSystemId = (typeof SOURCE_SYSTEM_IDS)[number];

export const TALENT_CREATED = 'talent.created' as const;
export const TALENT_PROFILE_UPDATED = 'talent.profile_updated' as const;
export const TALENT_ERASED = 'talent.erased' as const;

/** Events the ATS outbox emits toward TI. */
export const ATS_TALENT_EVENT_TYPES = [TALENT_CREATED, TALENT_PROFILE_UPDATED, TALENT_ERASED] as const;
export type AtsTalentEventType = (typeof ATS_TALENT_EVENT_TYPES)[number];

export const GOLDEN_TALENT_PROFILE_UPDATED = 'golden_talent.profile_updated' as const;

/** Events the TI outbox emits toward the ATS (HMAC-signed webhook). */
export const INTELLIGENCE_EVENT_TYPES = [GOLDEN_TALENT_PROFILE_UPDATED] as const;
export type IntelligenceEventType = (typeof INTELLIGENCE_EVENT_TYPES)[number];

export function isAtsTalentEventType(value: unknown): value is AtsTalentEventType {
  return typeof value === 'string' && (ATS_TALENT_EVENT_TYPES as readonly string[]).includes(value);
}

export function isIntelligenceEventType(value: unknown): value is IntelligenceEventType {
  return typeof value === 'string' && (INTELLIGENCE_EVENT_TYPES as readonly string[]).includes(value);
}
