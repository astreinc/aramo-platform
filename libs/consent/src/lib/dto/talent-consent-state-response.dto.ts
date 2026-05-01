import type { TalentConsentScopeStateDto } from './talent-consent-scope-state.dto.js';

// Mirrors openapi/common.yaml TalentConsentStateResponse schema (PR-5,
// Decision A). Wrapped envelope: metadata + per-scope state array.
//
// `is_anonymized` is the right-to-be-forgotten signal. PR-5 limitation
// per Decision F: always false in PR-5 because the talent module that
// provides identity-existence detection does not exist yet. The field
// is in the response schema for forward-compatibility; future PRs wire
// the actual detection. This is the "schema-now-detection-later"
// precedent that ADR-0007 will document.
//
// `scopes` always contains all 5 ConsentScope values per Decision D
// (always-5-scopes deterministic response).
export interface TalentConsentStateResponseDto {
  talent_id: string;
  tenant_id: string;
  is_anonymized: boolean;
  computed_at: string;
  scopes: TalentConsentScopeStateDto[];
}
