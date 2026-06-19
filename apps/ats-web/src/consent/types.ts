// TypeScript types for the three consent read responses (PR-9 §4.1).
//
// Mirror openapi/common.yaml verbatim:
//   - TalentConsentStateResponse  (#1079)
//   - ConsentHistoryResponse      (#1166)
//   - ConsentDecisionLogResponse  (#1256)
//
// Discipline (PR-9 §7, R10 mitigation): each schema carries
// additionalProperties: false; the TypeScript types carry only the
// fields the schemas define. Anything not in these types cannot
// reach the panels — R10 (no examination output exposure) is enforced
// at the type level. Same pattern PR-8 used for Session.
//
// is_anonymized is the right-to-be-forgotten signal (ADR-0007
// Decision F). Always false in M0; PR-9 honors it defensively
// (PR-9 §4.4). RTBF initiation surfaces are M6 scope.

export type ConsentScope =
  | 'profile_storage'
  | 'resume_processing'
  | 'matching'
  | 'contacting'
  | 'cross_tenant_visibility';

// The five scopes, in the order ConsentStatePanel renders them.
export const CONSENT_SCOPES: readonly ConsentScope[] = [
  'profile_storage',
  'resume_processing',
  'matching',
  'contacting',
  'cross_tenant_visibility',
];

export type ConsentScopeStatus =
  | 'granted'
  | 'revoked'
  | 'expired'
  | 'no_grant';

export type ConsentDecisionAction = 'granted' | 'revoked' | 'expired';

export type ConsentDecisionLogEventType =
  | 'consent.grant.recorded'
  | 'consent.revoke.recorded'
  | 'consent.check.decision';

export type ConsentActorType = 'recruiter' | 'self' | 'system';

export interface TalentConsentScopeState {
  scope: ConsentScope;
  status: ConsentScopeStatus;
  granted_at: string | null;
  revoked_at: string | null;
  expires_at: string | null;
}

export interface TalentConsentStateResponse {
  talent_id: string;
  tenant_id: string;
  is_anonymized: boolean;
  computed_at: string;
  scopes: TalentConsentScopeState[];
}

export interface ConsentHistoryEvent {
  event_id: string;
  scope: ConsentScope;
  action: ConsentDecisionAction;
  created_at: string;
  expires_at: string | null;
}

export interface ConsentHistoryResponse {
  events: ConsentHistoryEvent[];
  next_cursor: string | null;
  is_anonymized: boolean;
}

export interface ConsentDecisionLogEntry {
  event_id: string;
  talent_id: string;
  event_type: ConsentDecisionLogEventType;
  created_at: string;
  actor_id: string | null;
  actor_type: ConsentActorType;
  // event_payload is the documented opaque JSON pass-through per
  // ConsentDecisionLogEntry (openapi/common.yaml). Panels do not
  // render payload fields; the directive forbids extracting payload
  // fields into top-level surfaces. Keep this typed as an opaque
  // record so the contract is preserved through the type system.
  event_payload: Record<string, unknown>;
}

export interface ConsentDecisionLogResponse {
  entries: ConsentDecisionLogEntry[];
  next_cursor: string | null;
  is_anonymized: boolean;
}
