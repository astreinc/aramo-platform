import type {
  ConsentCaptureMethodValue,
  ConsentCaptureScopeValue,
} from './consent-capture-request.dto.js';

// One recorded grant per affirmatively-attested scope. The hash is the sha256 of
// the EXACT server-rendered versioned text (the D7 evidence preimage), computed
// server-side — the FE never supplies legal text.
export interface ConsentCaptureScopeResult {
  scope: ConsentCaptureScopeValue;
  event_id: string;
  consent_version: string;
  consent_text_hash: string;
  occurred_at: string;
  expires_at?: string;
  recorded_at: string;
}

export interface ConsentCaptureResponseDto {
  talent_record_id: string;
  captured_method: ConsentCaptureMethodValue;
  consent_version: string;
  results: ConsentCaptureScopeResult[];
}
