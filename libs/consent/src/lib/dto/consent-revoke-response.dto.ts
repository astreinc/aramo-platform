import type {
  ConsentLedgerCapturedMethodValue,
  ConsentScopeValue,
} from './consent-grant-request.dto.js';

// Server-shaped response. `action` is locked to "revoked" (PR-3 endpoint
// always returns revoked). `revoked_event_id` is server-derived per
// Decision A; null per Decision D when no prior grant exists.
export interface ConsentRevokeResponseDto {
  event_id: string;
  tenant_id: string;
  talent_record_id: string;
  scope: ConsentScopeValue;
  action: 'revoked';
  // Ledger vocabulary (CONSENT-RECRUITER-CREATE-DEFAULT-1): the HTTP grant/revoke
  // routes only ever echo a request method (CONSENT_CAPTURED_METHODS); the wider
  // type covers the server-only recruiter_create_default write via the same writer.
  captured_method: ConsentLedgerCapturedMethodValue;
  captured_by_actor_id?: string;
  consent_version: string;
  consent_document_id?: string;
  occurred_at: string;
  recorded_at: string;
  revoked_event_id: string | null;
  metadata?: Record<string, unknown>;
}
