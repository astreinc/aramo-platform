// Commercial Plans Amendment A1 review — a plan's ENTITLEMENT (what the
// catalog says the plan includes) is kept apart from the capability's LAUNCH
// AVAILABILITY (whether it is built and operational). The catalog keeps the
// approved entitlements; anything not available is never advertised as
// delivered. Moving a key to AVAILABLE is a governed change made when the
// capability ships.

export type FeatureAvailability = 'AVAILABLE' | 'NOT_AVAILABLE';

export const FEATURE_AVAILABILITY: Readonly<Record<string, FeatureAvailability>> = {
  // Sending envelopes for signature (the Sign engine).
  'sign.envelopes': 'AVAILABLE',
  // Per-tenant storage allocation (enforced at upload).
  'sign.storage_bytes': 'AVAILABLE',
  // Shared organization workspace: several users with Sign roles see and act on
  // the organization's envelopes (PX-1 business workspace, role-based access).
  'sign.team_collaboration': 'AVAILABLE',
  // Aramo-Sign-Unified-Product-Amendment-M-A5 §3.7 — hosted (in-person) signing.
  // Available wherever Sign sending is available unless the PO restricts it.
  'sign.in_person_signing': 'AVAILABLE',
  // Not built: the console shows templates as a future capability (PX-V1 §15);
  // there is no forms feature; no AI summary exists for Sign.
  'sign.templates': 'NOT_AVAILABLE',
  'sign.forms': 'NOT_AVAILABLE',
  'sign.ai_assist_summary': 'NOT_AVAILABLE',
  'sign.advanced_analytics': 'NOT_AVAILABLE',
  'sign.custom_domain': 'NOT_AVAILABLE',
};

/** Unknown keys are not available (never advertise what is not registered). */
export function isFeatureAvailable(key: string, registry: Readonly<Record<string, FeatureAvailability>> = FEATURE_AVAILABILITY): boolean {
  return registry[key] === 'AVAILABLE';
}
