import type { ConsentScopeValue } from './consent-grant-request.dto.js';

// Per-event DTO for /consent/history (PR-6 §4).
//
// Field set is closed at exactly five fields per directive §4. Adding a
// field requires a new ADR; doing so without one is a halt condition (§9).
//
// Field naming: `event_id` is the API/DTO surface name; the underlying
// Prisma column is `id`. The mapping is documented in directive §5 (the
// only renaming permitted in PR-6) and matches the precedent set by
// ConsentRevokeResponse.event_id and ConsentDecision.decision_id.
//
// `action` is a string corresponding to ConsentDecisionAction values
// (granted | revoked | expired) — historical events preserve their
// original action; staleness is enforcement metadata applied at check
// time only and is never written into historical records (directive §6).
//
// `expires_at` is nullable and originates from TalentConsentEvent.expires_at
// (explicit expiration set at grant time; absent on revoke/expired records).
export interface ConsentHistoryEventDto {
  event_id: string;
  scope: ConsentScopeValue;
  action: string;
  created_at: string;
  expires_at: string | null;
}
