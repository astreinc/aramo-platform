import type { ConsentScopeValue } from './consent-grant-request.dto.js';

// Mirrors openapi/common.yaml ConsentDecision schema (PR-4).
// Spec source: API Contracts Phase 1 §1 Common Schemas (lines 469-489).
//
// `result` discriminates allowed/denied/error states. `reason_code` carries
// the denial reason ("stale_consent", "scope_dependency_unmet",
// "channel_not_consented", "consent_state_unknown", etc.). `denied_scopes`
// lists the scopes that failed (used in 422 dependency violations and
// staleness/channel denials).
//
// Returned directly in 200 responses. Embedded in error.details.consent_decision
// in 4xx envelopes per Phase 1 §1 canonical embedding pattern (lines 338-381).
export interface ConsentDecisionDto {
  result: 'allowed' | 'denied' | 'error';
  scope?: ConsentScopeValue;
  denied_scopes?: ConsentScopeValue[];
  reason_code?: string;
  display_message?: string;
  log_message?: string;
  decision_id: string;
  computed_at: string;
}
