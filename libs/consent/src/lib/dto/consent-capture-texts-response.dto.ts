import type {
  ConsentCaptureMethodValue,
  ConsentCaptureScopeValue,
} from './consent-capture-request.dto.js';

// The EXACT versioned consent text the recruiter must see before recording, per
// scope — the same render the capture write-path hashes, so the displayed bytes
// ARE the D7 hash preimage (mirrors getPortalConsentTexts for the portal flow).
export interface ConsentCaptureTextEntry {
  scope: ConsentCaptureScopeValue;
  text: string;
}

export interface ConsentCaptureTextsResponseDto {
  version: string;
  captured_method: ConsentCaptureMethodValue;
  texts: ConsentCaptureTextEntry[];
}
