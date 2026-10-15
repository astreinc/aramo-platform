// Build-time FE feature flags. ats-web has no runtime flag service; a flag here is
// read once from the Vite env at build time and defaults OFF. A flag gates
// PRESENTATION only — the backend stays authoritative for every capability.

function envFlag(value: string | undefined): boolean {
  return value === 'true' || value === '1';
}

export interface FeatureFlags {
  /**
   * Talent × Requisition 360 → Technical Screening tab, full layout. OFF: the tab
   * renders only the "No technical screening yet" empty state with the CTA hidden.
   * The INC-3 screening scope expansion (LLM questions, recording/transcript,
   * Assist follow-ups) is not authorized — no such call is wired either way.
   */
  readonly techScreening360: boolean;
}

export const FEATURE_FLAGS: FeatureFlags = {
  techScreening360: envFlag(import.meta.env['VITE_FF_TECH_SCREENING_360'] as string | undefined),
};
