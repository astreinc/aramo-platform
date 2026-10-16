// Display labels for the closed vocabularies Talent 360 and Talent × Requisition
// 360 render. Codes never reach the screen raw: each maps through a canonical
// label map (stated-fields for availability / engagement / work authorization)
// or one of the maps below. Unknown codes fall back to sentence case so a new
// backend value degrades readably instead of breaking.
import { AVAILABILITY_LABELS, ENGAGEMENT_LABELS } from '../talent/stated-fields';

function fallback(code: string): string {
  const t = code.replace(/[_-]+/g, ' ').trim().toLowerCase();
  return t.charAt(0).toUpperCase() + t.slice(1);
}
function from(map: Readonly<Record<string, string>>, code: string): string {
  return map[code] ?? map[code.toLowerCase()] ?? fallback(code);
}

export function availabilityLabel(code: string): string {
  return from(AVAILABILITY_LABELS, code);
}
export function engagementLabel(code: string): string {
  return from(ENGAGEMENT_LABELS, code);
}

// libs/pipeline PIPELINE_DISPOSITION_REASONS (all four authority classes).
export const DISPOSITION_REASON_LABELS: Readonly<Record<string, string>> = {
  not_a_fit: 'Not a fit',
  skills_mismatch: 'Skills mismatch',
  better_matched_elsewhere: 'Better matched elsewhere',
  withdrawn_by_recruiter: 'Withdrawn by recruiter',
  talent_declined: 'Talent declined',
  talent_unresponsive: 'Talent unresponsive',
  talent_accepted_other_role: 'Talent accepted another role',
  compensation_misalignment: 'Compensation misalignment',
  requisition_closed: 'Requisition closed',
  requisition_on_hold: 'Requisition on hold',
  client_paused_engagement: 'Client paused the engagement',
  position_filled_externally: 'Position filled externally',
  placement_started: 'Placement started',
  placement_completed: 'Placement completed',
  placement_fell_through: 'Placement fell through',
  converted_to_permanent: 'Converted to permanent',
  client_selection_declined: 'Client declined',
  client_selection_withdrawn: 'Withdrawn from client',
};
export function dispositionReasonLabel(code: string): string {
  return from(DISPOSITION_REASON_LABELS, code);
}

// pipeline/talent-journey-api JourneyOwner.
export const JOURNEY_OWNER_LABELS: Readonly<Record<string, string>> = {
  pipeline: 'Recruiting',
  submittal: 'Submittal',
  'client-selection': 'Client selection',
  interview: 'Interviews',
  offer: 'Offer',
  placement: 'Placement',
  'pre-start': 'Pre-start',
  assignment: 'Assignment',
};
export function journeyOwnerLabel(code: string): string {
  return from(JOURNEY_OWNER_LABELS, code);
}

// Communication interaction channels (the backend's channelNoun vocabulary).
export const CHANNEL_LABELS: Readonly<Record<string, string>> = {
  voice: 'Call',
  phone: 'Call',
  call: 'Call',
  email: 'Email',
  sms: 'Text',
  meeting: 'Meeting',
};
export function channelLabel(code: string): string {
  return from(CHANNEL_LABELS, code);
}

// Declared work-history source (TalentWorkHistorySource). A sealed external
// profile source is not named on screen.
export const WORK_HISTORY_SOURCE_LABELS: Readonly<Record<string, string>> = {
  resume: 'From resume',
  manual: 'Entered manually',
  import: 'Imported',
};
export function workHistorySourceLabel(code: string): string {
  return WORK_HISTORY_SOURCE_LABELS[code.toLowerCase()] ?? 'External profile';
}
