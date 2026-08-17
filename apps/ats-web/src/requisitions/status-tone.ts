import type { PillTone } from '../ui';

import type { RecruitingStatus } from './types';

// T10-B4/F-028 — the SINGLE source for RecruitingStatus → pill tone. This map
// was byte-duplicated across the requisitions list, requisition detail, and the
// dashboard rollup; the labels already live in ./types
// (RECRUITING_STATUS_LABELS), and this is the tone companion. Presentation-only
// (tones), no state-machine / enum / lifecycle change.
export const RECRUITING_STATUS_TONE: Record<RecruitingStatus, PillTone> = {
  lead: 'neutral',
  draft: 'neutral',
  pending_approval: 'warn',
  open: 'ok',
  on_hold: 'warn',
  submittals_closed: 'brand',
  canceled: 'danger',
  closed: 'neutral',
  archived: 'neutral',
};
