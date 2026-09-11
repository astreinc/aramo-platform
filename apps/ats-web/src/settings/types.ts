// Hand-mirrored shape of TenantSettingsView (libs/settings exports the
// canonical type; the FE re-declares it to preserve the no-@aramo/*
// import rule — apps/tenant-console stays a leaf consumer of the HTTP
// surface).
//
// Mirror source: libs/settings/src/lib/known-settings.ts + dto/tenant-
// settings.view.ts (S2 + S4 keys: compensation.display_default,
// audit.financials_enabled). If a new known-key lands on the backend,
// this file follows in lock-step at the next FE PR that wires it.

export type CompensationDisplayDefault = 'spread' | 'markup' | 'both';

export const COMPENSATION_DISPLAY_DEFAULT_VALUES: readonly CompensationDisplayDefault[] =
  Object.freeze(['spread', 'markup', 'both']);

// Résumé extraction mode (Add Talent). 'deterministic' = the no-LLM heuristic
// parser (default); 'governed_llm' = governed extraction via libs/ai-draft.
// Tenant-level feature opt-in; the sole gate for the LLM path.
export type ResumeExtractionMode = 'deterministic' | 'governed_llm';

export const RESUME_EXTRACTION_MODE_VALUES: readonly ResumeExtractionMode[] =
  Object.freeze(['deterministic', 'governed_llm']);

export interface TenantSettingsView {
  readonly 'compensation.display_default': CompensationDisplayDefault;
  readonly 'audit.financials_enabled': boolean;
  readonly 'resume.extraction_mode': ResumeExtractionMode;
}

// Per-key value type — keeps the call-site precise without a generic.
export type TenantSettingValue<K extends keyof TenantSettingsView> =
  TenantSettingsView[K];

export interface TenantSettingSetResult<K extends keyof TenantSettingsView> {
  readonly key: K;
  readonly value: TenantSettingValue<K>;
  readonly previous_value: TenantSettingValue<K> | null;
}
