// FE hand-mirror of libs/talent-record/src/lib/dto/stated-fields.ts. The
// ats-web must not import @aramo/talent-record (domain-edge ban), so
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

// Gate-1 G1-A (R6) — talent-STATED work authorization; mirrors the BE
// WORK_AUTHORIZATION_VALUES (which reuse talent_evidence's
// TalentWorkAuthorizationStatus vocab). Kept 1:1 by stated-fields.drift.spec.ts.
export const WORK_AUTHORIZATION_VALUES = [
  'US_CITIZEN',
  'PERMANENT_RESIDENT',
  'VISA_HOLDER',
  'REQUIRES_SPONSORSHIP',
  'OTHER',
  'NOT_DISCLOSED',
] as const;
export type WorkAuthorization = (typeof WORK_AUTHORIZATION_VALUES)[number];

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

export const WORK_AUTHORIZATION_LABELS: Record<WorkAuthorization, string> = {
  US_CITIZEN: 'U.S. citizen',
  PERMANENT_RESIDENT: 'Permanent resident',
  VISA_HOLDER: 'Visa holder',
  REQUIRES_SPONSORSHIP: 'Requires sponsorship',
  OTHER: 'Other',
  NOT_DISCLOSED: 'Not disclosed',
};

// Talent pay fields (desired_pay / current_pay) are free text ("70/hr"). Default
// the currency to $: prepend it when the stated value starts with a number and
// carries no currency of its own ("€65/hr", "Negotiable" are left as entered).
export const PAY_FIELD_KEYS = ['desired_pay', 'current_pay'] as const;
export function withCurrency(raw: string): string;
export function withCurrency(raw: string | null | undefined): string | null;
export function withCurrency(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const t = raw.trim();
  if (t === '') return raw;
  return /^[0-9.]/.test(t) ? `$${t}` : t;
}
