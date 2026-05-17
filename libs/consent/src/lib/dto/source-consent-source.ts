// Source-type vocabulary for the source-consent registration
// operation (PR-13 directive §4.3). Mirrors the AdapterType enum
// from API Contracts v1.0 Phase 4 "Allowed Adapter Types", as
// corrected by the Cross-Spec Vocabulary Amendment v1.0 at canonical.
//
// Defined in libs/consent (not imported from libs/ingestion) because
// the source-consent mapping RULE lives in libs/consent — the
// consent module remains the authority on consent semantics. The
// libs/ingestion INGESTION_SOURCES enum is the wire-side counterpart;
// alignment between the two is verified by tests.
export const CONSENT_SOURCE_TYPES = [
  'talent_direct',
  'indeed',
  'github',
  'astre_import',
] as const;

export type ConsentSourceType = (typeof CONSENT_SOURCE_TYPES)[number];
