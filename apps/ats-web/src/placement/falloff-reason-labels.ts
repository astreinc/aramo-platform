// Track 7 / T7-P5 §3.5 — the frontend-owned CLOSED falloff-reason label map. The backend
// exposes only the codes (no human labels on the wire / OpenAPI enum), so the UI owns the
// canonical labels here. The keys must EXACTLY match the governed backend registry
// (libs/placement/src/lib/reasons/permanent-falloff-reasons.ts) + the OpenAPI
// PermanentFalloffRequest.reason enum — enforced by ./falloff-reason-drift.spec.ts. No OTHER,
// no free-text reason. Do not add codes.

export const FALLOFF_REASON_CODES = [
  'TALENT_RESIGNED',
  'CLIENT_TERMINATED_PERFORMANCE',
  'CLIENT_TERMINATED_CONDUCT',
  'CLIENT_TERMINATED_BUSINESS_NEED',
  'MUTUAL_SEPARATION',
  'JOB_ABANDONMENT',
  'EMPLOYMENT_INELIGIBILITY',
] as const;
export type FalloffReasonCode = (typeof FALLOFF_REASON_CODES)[number];

export const FALLOFF_REASON_LABELS: Record<FalloffReasonCode, string> = {
  TALENT_RESIGNED: 'Talent resigned',
  CLIENT_TERMINATED_PERFORMANCE: 'Client terminated — performance',
  CLIENT_TERMINATED_CONDUCT: 'Client terminated — conduct',
  CLIENT_TERMINATED_BUSINESS_NEED: 'Client terminated — business need',
  MUTUAL_SEPARATION: 'Mutual separation',
  JOB_ABANDONMENT: 'Job abandonment',
  EMPLOYMENT_INELIGIBILITY: 'Employment ineligibility',
};

// Render a governed falloff code as its label; an unknown code (should be impossible under the
// drift guard) renders verbatim rather than blank, so a real value is never silently lost.
export function falloffReasonLabel(code: string): string {
  return (FALLOFF_REASON_LABELS as Record<string, string>)[code] ?? code;
}
