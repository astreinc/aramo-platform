import type { ConsentScopeStatus } from '@aramo/common';

import type { ConsentScopeValue } from './consent-grant-request.dto.js';

// Mirrors openapi/common.yaml TalentConsentScopeState schema (PR-5,
// Decision C). Per-scope state derived by resolveAllScopes.
//
// Distinct from PortalConsentScopeState (Phase 3, lines 917-938) which
// adds Portal-specific fields (`is_stale`, `display_label`).
// PR-5 Decision C: universal common-API surface excludes Portal projection
// concerns. PR-5 Decision E: no `is_stale` (consistent with ADR-0006
// Decision A's exclusion from ConsentDecision).
//
// Timestamps are nullable:
//   - granted_at: latest grant event's occurred_at, null if no grant
//   - revoked_at: latest revocation event's occurred_at, null if not
//                 revoked
//   - expires_at: explicit expiration set on the controlling grant event
//                 (TalentConsentEvent.expires_at), null when absent
export interface TalentConsentScopeStateDto {
  scope: ConsentScopeValue;
  status: ConsentScopeStatus;
  granted_at: string | null;
  revoked_at: string | null;
  expires_at: string | null;
}
