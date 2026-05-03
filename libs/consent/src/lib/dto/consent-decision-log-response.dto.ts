import type { ConsentDecisionLogEntryDto } from './consent-decision-log-entry.dto.js';

// Wrapped response DTO for GET /consent/decision-log/{talent_id} (PR-7 §4).
//
// Wrapped, never bare. Never 404 on empty (ADR-0007 Decision D). Empty
// decision log returns { entries: [], next_cursor: null,
// is_anonymized: false } with HTTP 200.
//
// `is_anonymized` is hardcoded `false` (ADR-0007 Decision F; matches the
// PR-5/PR-6 precedent). The talent module providing identity-existence
// detection does not exist yet; the field is in the schema for forward-
// compatibility.
//
// `next_cursor` is null when there are no more pages, otherwise an opaque
// base64url string encoding the (created_at, event_id) tuple of the last
// entry in this page (PR-7 §6; cursor module reused as-is from PR-6).
export interface ConsentDecisionLogResponseDto {
  entries: ConsentDecisionLogEntryDto[];
  next_cursor: string | null;
  is_anonymized: boolean;
}
