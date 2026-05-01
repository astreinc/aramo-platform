import type { ConsentHistoryEventDto } from './consent-history-event.dto.js';

// Wrapped response DTO for GET /consent/history/{talent_id} (PR-6 §4).
//
// Wrapped, never bare. Never 404 on empty (directive §4 + §7 test 7).
// Empty history returns { events: [], next_cursor: null, is_anonymized:
// false } with HTTP 200.
//
// `is_anonymized` is hardcoded `false` in PR-6 (directive §4 implementation
// hint, matches resolveAllScopes precedent on main and inherits ADR-0007
// Decision F). The talent module providing identity-existence detection
// does not exist yet; the field is in the schema for forward-compatibility.
//
// `next_cursor` is null when there are no more pages, otherwise an opaque
// base64url string encoding the (created_at, event_id) tuple of the last
// event in this page (directive §5).
export interface ConsentHistoryResponseDto {
  events: ConsentHistoryEventDto[];
  next_cursor: string | null;
  is_anonymized: boolean;
}
