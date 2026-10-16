// Display labels for the Unified Talent Journey vocabularies (pipeline/talent-journey-api
// JourneyOwner + the BE JourneyStageName). Kept apart from the read client so specs that
// mock the API module still get the real labels.
import { codeLabel } from '../ui/code-label';

// Display labels for the journey owner (the aggregate a stage / action attributes to).
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
  return codeLabel(JOURNEY_OWNER_LABELS, code);
}

// The BE-composed UI funnel stage (apps/api talent-journey.view JourneyStageName). Typed as a
// string on the wire mirror (the FE never branches on it); these are its display labels.
export const JOURNEY_STAGE_LABELS: Readonly<Record<string, string>> = {
  SOURCED: 'No contact',
  CONTACTED: 'Contacted',
  ENGAGED: 'Talent responded',
  QUALIFYING: 'Qualifying',
  QUALIFIED: 'Qualified',
  SUBMITTED: 'Submitted',
  CLIENT_REVIEW: 'Client review',
  INTERVIEW: 'Interview',
  CLIENT_DECLINED: 'Client declined',
  OFFER: 'Offer',
  ACCEPTED_PLACED: 'Offer accepted',
  PRE_START: 'Pre-start',
  READY: 'Ready to start',
  STARTED: 'Started',
  NOT_IN_CONSIDERATION: 'Not in consideration',
  COMPLETED: 'Completed',
};
export function journeyStageLabel(code: string): string {
  return codeLabel(JOURNEY_STAGE_LABELS, code);
}
