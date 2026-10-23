import { EVENT_VERSION, isAtsTalentEventType, type AtsTalentEventType, type EventVersion } from './events.js';

// ADR-0036 Decision 3 — the ATS → TI envelope carries IDS ONLY: no PII and no
// document reference. The publisher reads committed ATS data and builds the
// allowlisted admission payload separately (T2 fills TalentIngestionRequest).
export interface AtsTalentEventEnvelope {
  event_id: string;
  event_type: AtsTalentEventType;
  event_version: EventVersion;
  tenant_id: string;
  talent_id: string;
  occurred_at: string;
}

export interface GoldenTalentProfileUpdatedEnvelope {
  event_id: string;
  event_type: 'golden_talent.profile_updated';
  event_version: EventVersion;
  intelligence_subject_id: string;
  occurred_at: string;
}

const ENVELOPE_KEYS = ['event_id', 'event_type', 'event_version', 'tenant_id', 'talent_id', 'occurred_at'] as const;

/** Structural guard: exactly the envelope keys, ids as non-empty strings, v1 only. */
export function isAtsTalentEventEnvelope(value: unknown): value is AtsTalentEventEnvelope {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== ENVELOPE_KEYS.length) return false;
  if (!ENVELOPE_KEYS.every((k) => k in record)) return false;
  if (!isAtsTalentEventType(record['event_type'])) return false;
  if (record['event_version'] !== EVENT_VERSION) return false;
  return (['event_id', 'tenant_id', 'talent_id', 'occurred_at'] as const).every(
    (k) => typeof record[k] === 'string' && (record[k] as string).length > 0,
  );
}
