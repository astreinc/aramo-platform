import type {
  ConsentCapturedMethodValue,
  ConsentScopeValue,
} from './consent-grant-request.dto.js';

// Server-shaped response. `action` is locked to "revoked" (PR-3 endpoint
// always returns revoked). `revoked_event_id` is server-derived per
// Decision A; null per Decision D when no prior grant exists.
export interface ConsentRevokeResponseDto {
  event_id: string;
  tenant_id: string;
  talent_id: string;
  scope: ConsentScopeValue;
  action: 'revoked';
  captured_method: ConsentCapturedMethodValue;
  captured_by_actor_id?: string;
  consent_version: string;
  consent_document_id?: string;
  occurred_at: string;
  recorded_at: string;
  revoked_event_id: string | null;
  metadata?: Record<string, unknown>;
}
