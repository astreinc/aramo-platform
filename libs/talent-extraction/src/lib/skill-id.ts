import { v5 as uuidv5 } from 'uuid';

// Gate-1 G1-A (R2) — deterministic skill_id derivation.
//
// TalentSkillEvidence.skill_id is a non-null UUID that (per ADR-0016 §7.3) is a
// forward-reference to the not-yet-built SkillTaxonomy. Until that lands, the
// matching engine matches by NAME (surface_form), not by canonical id. We still
// must supply a skill_id, so we derive a STABLE, deterministic UUID from the
// normalized surface form: the same skill text → the same skill_id across every
// talent + run. This lets evidence be grouped/counted by skill_id OR
// surface_form consistently, and a future SkillTaxonomy backfill can remap
// these deterministic ids to canonical ones.
//
// Fixed namespace (uuid v5) — do NOT change; changing it re-keys every derived
// skill_id.
export const ARAMO_SKILL_NAMESPACE = 'a5f1c0de-5c11-4a5e-9b00-5ec0de5ec0de';

// Normalize a raw skill surface form for stable id derivation: trim, lowercase,
// collapse internal whitespace. (Presentation keeps the original surface_form;
// only the id derivation uses the normalized value.)
export function normalizeSkillSurfaceForm(surfaceForm: string): string {
  return surfaceForm.trim().toLowerCase().replace(/\s+/g, ' ');
}

// Deterministic skill_id for a surface form. Same normalized text → same UUID.
export function deriveSkillId(surfaceForm: string): string {
  return uuidv5(normalizeSkillSurfaceForm(surfaceForm), ARAMO_SKILL_NAMESPACE);
}
