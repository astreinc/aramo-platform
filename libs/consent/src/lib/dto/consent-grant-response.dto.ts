import type {
  ConsentLedgerCapturedMethodValue,
  ConsentScopeValue,
} from './consent-grant-request.dto.js';

// Server-shaped response. `action` is locked to "granted" (PR-2 endpoint
// always returns granted; PR-3 revoke returns "revoked").
export interface ConsentGrantResponseDto {
  event_id: string;
  tenant_id: string;
  talent_record_id: string;
  scope: ConsentScopeValue;
  action: 'granted';
  // Ledger vocabulary (CONSENT-RECRUITER-CREATE-DEFAULT-1): the HTTP grant/revoke
  // routes only ever echo a request method (CONSENT_CAPTURED_METHODS); the wider
  // type covers the server-only recruiter_create_default write via the same writer.
  captured_method: ConsentLedgerCapturedMethodValue;
  captured_by_actor_id?: string;
  consent_version: string;
  consent_document_id?: string;
  occurred_at: string;
  expires_at?: string;
  recorded_at: string;
  metadata?: Record<string, unknown>;
}
