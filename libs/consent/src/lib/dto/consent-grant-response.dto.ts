import type {
  ConsentCapturedMethodValue,
  ConsentScopeValue,
} from './consent-grant-request.dto.js';

// Server-shaped response. `action` is locked to "granted" (PR-2 endpoint
// always returns granted; PR-3 revoke returns "revoked").
export interface ConsentGrantResponseDto {
  event_id: string;
  tenant_id: string;
  talent_id: string;
  scope: ConsentScopeValue;
  action: 'granted';
  captured_method: ConsentCapturedMethodValue;
  captured_by_actor_id?: string;
  consent_version: string;
  consent_document_id?: string;
  occurred_at: string;
  expires_at?: string;
  recorded_at: string;
  metadata?: Record<string, unknown>;
}
