// Build-time FE feature flags. ats-web has no runtime flag service; a flag here is
// read once from the Vite env at build time and defaults OFF. A flag gates
// PRESENTATION only — the backend stays authoritative for every capability.

function envFlag(value: string | undefined): boolean {
  return value === 'true' || value === '1';
}

export interface FeatureFlags {
  /**
   * Talent × Requisition 360 → Technical Screening tab. ON: the tab hosts the
   * INC-3 screening flow as amended by ARAMO-TIP-E2E-INC-3-A1-v1.0-LOCKED, on
   * this page per A1 Note 1 (TR360 as a second host), using only the existing
   * INC-3/A1 routes and scopes. OFF: the tab renders only the "No technical
   * screening yet" empty state with the CTA hidden and makes no screening call.
   * Default OFF: A1 grants no production activation (A1 :474; Note 1 §2).
   */
  readonly techScreening360: boolean;
}

export const FEATURE_FLAGS: FeatureFlags = {
  techScreening360: envFlag(import.meta.env['VITE_FF_TECH_SCREENING_360'] as string | undefined),
};
