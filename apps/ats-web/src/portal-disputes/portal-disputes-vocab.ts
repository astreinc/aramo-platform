// Display labels for the dispute vocabularies. ATI-SEP-1 T10 WP3b: disputes live in
// Talent Intelligence — item_type is the disputed assertion type
// (@aramo/intelligence-contracts ASSERTION_TYPES), status is DISPUTE_STATUSES.
// Kept apart from the API client so specs that mock it still get the real labels.
import { codeLabel } from '../ui/code-label';

export const PORTAL_DISPUTE_ITEM_TYPE_LABELS: Readonly<Record<string, string>> = {
  VERIFICATION_OUTCOME: 'Verification',
  WORK_HISTORY: 'Work history',
  CURRENT_EMPLOYER: 'Current employer',
  PUBLIC_PROFILE_URL: 'Public profile link',
  WORK_AUTHORIZATION: 'Work authorization',
};
export function portalDisputeItemTypeLabel(code: string): string {
  return codeLabel(PORTAL_DISPUTE_ITEM_TYPE_LABELS, code);
}

export const PORTAL_DISPUTE_STATUS_LABELS: Readonly<Record<string, string>> = {
  OPEN: 'Open',
  UNDER_REVIEW: 'Under review',
  RESOLVED_CORRECTED: 'Resolved — corrected',
  RESOLVED_UPHELD: 'Resolved — upheld',
  WITHDRAWN: 'Withdrawn',
  RESOLVED_NO_TRANSITION: 'Resolved — no change',
};
export function portalDisputeStatusLabel(code: string): string {
  return codeLabel(PORTAL_DISPUTE_STATUS_LABELS, code);
}
