// Talent-stated categorical fields — Talent Record Spec Amendment
// (stated-fields) v1.0 LOCKED.
//
// §5 representation ruling: String + closed vocabulary (NOT Prisma enums) —
// consistent with the PR-10 String/closed-vocabulary convention; a plain
// String column is btree-indexable for the Segment-4 server-side facet/sort.
// §6 topology: both land on the ATS TalentRecord (recruiter-CRM projection);
// NO Core Talent/overlay write (R12 — the Core model stays thin).
// §3 refusal posture: both are talent-STATED facts (R10-clean — a self-reported
// category, never a Portal-forbidden ordinal or inferred output).
//
// This module is the canonical source of the two closed vocabularies. The
// ats-web hand-mirrors these arrays (boundary forbids importing the
// lib) and a drift spec asserts the mirror stays 1:1.

// §4.1 — vocabulary closure of the existing canonical TalentDeclaredProfile
// field. `null` (never captured) and `'unknown'` (talent stated they don't
// know) are DISTINCT at the data layer; the UI "Unknown" bucket matches BOTH.
export const AVAILABILITY_STATUS_VALUES = [
  'available_now',
  'open_to_offers',
  'not_looking',
  'unknown',
] as const;
export type AvailabilityStatus = (typeof AVAILABILITY_STATUS_VALUES)[number];

// §4.2 — NEW declared field, orthogonal to TalentRateExpectation.employment_type
// (tax/legal axis — never conflate). `null` = not stated (no `unknown` member).
export const ENGAGEMENT_TYPE_VALUES = [
  'contract_to_hire',
  'contract',
  'direct_hire',
] as const;
export type EngagementType = (typeof ENGAGEMENT_TYPE_VALUES)[number];

// Closed-set guards — the @IsIn intent honored via the module's interface-DTO
// idiom (talent-record DTOs are interfaces, not class-validator classes). The
// controller/repository reject an out-of-vocabulary value at the wire boundary.
export function isAvailabilityStatus(v: unknown): v is AvailabilityStatus {
  return (
    typeof v === 'string' &&
    (AVAILABILITY_STATUS_VALUES as readonly string[]).includes(v)
  );
}
export function isEngagementType(v: unknown): v is EngagementType {
  return (
    typeof v === 'string' &&
    (ENGAGEMENT_TYPE_VALUES as readonly string[]).includes(v)
  );
}
