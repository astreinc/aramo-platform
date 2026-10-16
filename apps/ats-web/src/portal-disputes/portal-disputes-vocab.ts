// Display labels for the Portal dispute work-item vocabularies (hand-mirrored from
// libs/talent-trust vocab PORTAL_DISPUTE_ITEM_TYPES / PORTAL_DISPUTE_WORK_ITEM_STATES).
// Kept apart from the API client so specs that mock it still get the real labels.
import { codeLabel } from '../ui/code-label';

export const PORTAL_DISPUTE_ITEM_TYPE_LABELS: Readonly<Record<string, string>> = {
  ANCHOR: 'Contact detail',
  VERIFICATION: 'Verification',
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
