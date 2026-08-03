// T1-d Q6 — the ONE canonical recruiting-status display map for ats-web.
// Before T1-d, four label maps (list, detail, dashboard, reporting) disagreed:
// `active` was both "Active" and "Open"; `lead` was both "Intake" and "Lead".
// That four-way drift is a defect this PR closes. Every FE surface now reads
// these two maps; the backend reporting label map (libs/reporting) mirrors the
// same copy (the FE cannot import the lib — a forbidden domain edge).
//
// "Lead", not "Intake": intake is a meeting; lead is a state (a requisition
// heard-about but not confirmed, sourced against). See Track-1 §T1-d.

import type { PillTone } from '../ui';

import type { RecruitingStatus } from './types';

export const RECRUITING_STATUS_LABEL: Record<RecruitingStatus, string> = {
  draft: 'Draft',
  pending_approval: 'Pending approval',
  lead: 'Lead',
  open: 'Open',
  on_hold: 'On hold',
  submittals_closed: 'Submittals closed',
  closed: 'Closed',
  canceled: 'Canceled',
  archived: 'Archived',
};

export const RECRUITING_STATUS_TONE: Record<RecruitingStatus, PillTone> = {
  // Inert (present-but-inert, no rows reach them yet): neutral.
  draft: 'neutral',
  pending_approval: 'neutral',
  archived: 'neutral',
  // Live states.
  lead: 'neutral',
  open: 'ok',
  on_hold: 'warn',
  submittals_closed: 'brand', // inherits `full`'s tone
  closed: 'neutral',
  canceled: 'danger',
};
