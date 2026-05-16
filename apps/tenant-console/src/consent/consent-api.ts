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

import { apiClient } from '../api/client';

import type {
  ConsentDecisionLogResponse,
  ConsentHistoryResponse,
  TalentConsentStateResponse,
} from './types';

const STATE_BASE = '/v1/consent/state/';
const HISTORY_BASE = '/v1/consent/history/';
const DECISION_LOG_BASE = '/v1/consent/decision-log/';

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

function withCursor(path: string, cursor: string | null | undefined): string {
  if (cursor === undefined || cursor === null || cursor === '') {
    return path;
  }
  // Cursor is opaque base64url; pass through verbatim with URL-encoding.
  return `${path}?cursor=${encodeURIComponent(cursor)}`;
}
