// Thin wrapper over apiClient.get for the three consent read endpoints
// (PR-9 §4.1).
//
// Endpoints (substrate-confirmed at libs/consent/src/lib/consent.controller.ts):
//   GET /v1/consent/state/:talent_id
//   GET /v1/consent/history/:talent_id   ?cursor=&limit=&scope=
//   GET /v1/consent/decision-log/:talent_id  ?cursor=&limit=&event_type=
//
// All three return additionalProperties: false response shapes; the
// typed returns mirror those shapes exactly. PR-9 only consumes
// cursor (opaque, passed back verbatim — never parsed or constructed
// client-side per PR-9 §4.3). limit / scope / event_type filters are
// server-supported but PR-9 does not surface them in the UI.

import { apiClient } from '@aramo/fe-foundation';

import type {
  ConsentCaptureMethod,
  ConsentCaptureRequest,
  ConsentCaptureResponse,
  ConsentCaptureTextsResponse,
  ConsentDecisionLogResponse,
  ConsentHistoryResponse,
  TalentConsentStateResponse,
} from './types';

const STATE_BASE = '/v1/consent/state/';
const HISTORY_BASE = '/v1/consent/history/';
const DECISION_LOG_BASE = '/v1/consent/decision-log/';
const CAPTURE_PATH = '/v1/consent/capture';
const CAPTURE_TEXTS_PATH = '/v1/consent/capture-texts';

export function getTalentConsentState(
  talentId: string,
): Promise<TalentConsentStateResponse> {
  return apiClient.get<TalentConsentStateResponse>(
    `${STATE_BASE}${encodeURIComponent(talentId)}`,
  );
}

export function getTalentConsentHistory(
  talentId: string,
  cursor?: string | null,
): Promise<ConsentHistoryResponse> {
  const path = withCursor(
    `${HISTORY_BASE}${encodeURIComponent(talentId)}`,
    cursor,
  );
  return apiClient.get<ConsentHistoryResponse>(path);
}

export function getTalentConsentDecisionLog(
  talentId: string,
  cursor?: string | null,
): Promise<ConsentDecisionLogResponse> {
  const path = withCursor(
    `${DECISION_LOG_BASE}${encodeURIComponent(talentId)}`,
    cursor,
  );
  return apiClient.get<ConsentDecisionLogResponse>(path);
}

// PO RULING "Consent Capture" — the EXACT versioned consent text per scope the
// recruiter must see before recording (the D7 hash preimage; rendered server-side,
// never composed client-side).
export function getConsentCaptureTexts(
  capturedMethod: ConsentCaptureMethod,
): Promise<ConsentCaptureTextsResponse> {
  return apiClient.get<ConsentCaptureTextsResponse>(
    `${CAPTURE_TEXTS_PATH}?captured_method=${encodeURIComponent(capturedMethod)}`,
  );
}

// PO RULING "Consent Capture" — record the recruiter-captured profile consent
// through the server-authoritative capture seam (multi-scope, dependency-ordered,
// idempotent). A fresh Idempotency-Key per submit; a retry of the same selection
// is a replay, not a duplicate. Mirrors the mint pattern in pipeline-api.ts.
export function captureConsent(
  request: ConsentCaptureRequest,
): Promise<ConsentCaptureResponse> {
  return apiClient.post<ConsentCaptureResponse>(CAPTURE_PATH, request, {
    headers: { 'Idempotency-Key': crypto.randomUUID() },
  });
}

function withCursor(path: string, cursor: string | null | undefined): string {
  if (cursor === undefined || cursor === null || cursor === '') {
    return path;
  }
  // Cursor is opaque base64url; pass through verbatim with URL-encoding.
  return `${path}?cursor=${encodeURIComponent(cursor)}`;
}
