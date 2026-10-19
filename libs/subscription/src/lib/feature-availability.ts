// Commercial Plans Amendment A1 review — a plan's ENTITLEMENT (what the
// catalog says the plan includes) is kept apart from the capability's LAUNCH
// AVAILABILITY (whether it is built and operational). The catalog keeps the
// approved entitlements; anything not available is never advertised as
// delivered. Moving a key to AVAILABLE is a governed change made when the
// capability ships.

export type FeatureAvailability = 'AVAILABLE' | 'NOT_AVAILABLE';

export const FEATURE_AVAILABILITY: Readonly<Record<string, FeatureAvailability>> = {
  // Sending envelopes for signature (the Sign engine).
  'esign.envelopes': 'AVAILABLE',
  // Per-tenant storage allocation (enforced at upload).
  'esign.storage_bytes': 'AVAILABLE',
  // Shared organization workspace: several users with Sign roles see and act on
  // the organization's envelopes (PX-1 business workspace, role-based access).
  'esign.team_collaboration': 'AVAILABLE',
  // Not built: the console shows templates as a future capability (PX-V1 §15);
  // there is no forms feature; no AI summary exists for Sign.
  'esign.templates': 'NOT_AVAILABLE',
  'esign.forms': 'NOT_AVAILABLE',
  'esign.ai_assist_summary': 'NOT_AVAILABLE',
  'esign.advanced_analytics': 'NOT_AVAILABLE',
  'esign.custom_domain': 'NOT_AVAILABLE',
};

/** Unknown keys are not available (never advertise what is not registered). */
export function isFeatureAvailable(key: string, registry: Readonly<Record<string, FeatureAvailability>> = FEATURE_AVAILABILITY): boolean {
  return registry[key] === 'AVAILABLE';
}
