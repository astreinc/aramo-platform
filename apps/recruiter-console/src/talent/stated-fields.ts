// FE hand-mirror of libs/talent-record/src/lib/dto/stated-fields.ts. The
// recruiter-console must not import @aramo/talent-record (domain-edge ban), so
// the two closed vocabularies are mirrored here 1:1 and
// stated-fields.drift.spec.ts asserts they never drift from the BE source.
// R10-clean: these are talent-STATED categorical facts, never inferred.

export const AVAILABILITY_STATUS_VALUES = [
  'available_now',
  'open_to_offers',
  'not_looking',
  'unknown',
] as const;
export type AvailabilityStatus = (typeof AVAILABILITY_STATUS_VALUES)[number];

export const ENGAGEMENT_TYPE_VALUES = [
  'contract_to_hire',
  'contract',
  'direct_hire',
] as const;
export type EngagementType = (typeof ENGAGEMENT_TYPE_VALUES)[number];

export const AVAILABILITY_LABELS: Record<AvailabilityStatus, string> = {
  available_now: 'Available now',
  open_to_offers: 'Open to offers',
  not_looking: 'Not looking',
  unknown: 'Unknown',
};

export const ENGAGEMENT_LABELS: Record<EngagementType, string> = {
  contract_to_hire: 'Contract-to-hire',
  contract: 'Contract',
  direct_hire: 'Direct hire',
};
