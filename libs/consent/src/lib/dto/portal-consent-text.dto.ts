import type { ConsentScopeValue } from './consent-grant-request.dto.js';

// Portal P2 P2b (Directive §PR-2) — the rendered consent-text response for the
// portal grant flow. The portal user MUST see the EXACT versioned text whose
// hash P2a records; portal-web (scope:portal) cannot import @aramo/consent
// (scope:ats), so the backend renders it and the UI displays the bytes
// verbatim. Rendering + hashing share renderPortalConsentText, so the displayed
// text is definitionally the D7 hash preimage (no frontend divergence possible).
//
// ENGAGEMENT-class: `text` names the recipient by tenant_id (the canonical legal
// clause); it carries no R10/trust field. One entry per ConsentScope (all 5,
// deterministic — matches the always-5-scopes state precedent).
export interface PortalConsentTextEntryDto {
  scope: ConsentScopeValue;
  text: string;
}

export interface PortalConsentTextResponseDto {
  // The current consent-text version the portal user is being shown. Echoed
  // back on grant (the version whose hash the ledger records).
  version: string;
  texts: PortalConsentTextEntryDto[];
}
