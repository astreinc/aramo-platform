// SKILL-TAX-1E — canonical SHADOW-matching taxonomy + pure classifier.
//
// SHADOW ONLY: this computes a parallel, observe-only canonical view of the
// critical-skill match. It NEVER feeds the authoritative name/text matcher
// (frozen: derive-matching-input.ts + libs/matching engine) and NEVER appears on
// any API response. §45 (directive) defers the exact vocabulary to this phase;
// the Gate-6-RATIFIED v1 taxonomy = the 7 PROVABLE classes below (version/related/
// semantic classes from the aspirational §45 list are INERT at HEAD and omitted).
//
// RATIFIED semantics (Gate-6): classification is driven by the COMBINATION of two
// independent decisions over the FULL critical requisition set vs the FULL talent
// canonical set — NOT by decorating pairs the name matcher already produced:
//   • name-match  = the authoritative normalized-name matcher pairs them
//                   (a talent skill shares the requirement's normalized surface form);
//   • canonical-match = requisition + talent skill resolve to the SAME canonical id
//                   (compared across ALL talent skills, regardless of surface form).
//   CANONICAL_EXACT      = name-match AND canonical agrees.
//   ALIAS_EQUIVALENT     = name matcher MISSES it, but canonical identity agrees
//                          (the canonical-only match, e.g. K8s ↔ Kubernetes — the
//                          most important pre-cutover signal).
//   CANONICAL_DIFFERENCE = name-match, but resolved canonical identities disagree.
//   UNRESOLVED_*         = canonical comparison cannot complete (one/both sides
//                          unresolved), keyed on the name pairing.
//   SOURCE_SET_DIVERGENCE= authored critical set ≠ derived 1D critical set; PREEMPTS
//                          per-skill classification (the canonical substrate is not
//                          congruent, so per-skill agreement is unreliable).
// canonicalization_method is NOT used. A skill neither name- nor canonical-matched
// emits NO row (the talent genuinely lacks it — the matcher already reflects that).
//
// Governing invariant (§45): a related-skill signal must never masquerade as
// direct Talent evidence. v1 compares ONLY explicitly-stated skills by canonical
// identity — no inference, no expansion (§47-safe).
//
// PURITY: this module imports nothing app/DB/scope-bound. The caller normalizes
// surface forms with the AUTHORITATIVE normalizer (normalizeSkillSurfaceForm from
// @aramo/talent-extraction — the same one derive-matching-input uses) and passes
// pre-normalized `norm` keys in, so name-match is decided EXACTLY as the
// authoritative matcher decides it, with zero risk of normalizer drift.

export type CanonicalMatchClass =
  | 'CANONICAL_EXACT'
  | 'ALIAS_EQUIVALENT'
  | 'CANONICAL_DIFFERENCE'
  | 'UNRESOLVED_TALENT'
  | 'UNRESOLVED_REQUISITION'
  | 'UNRESOLVED_BOTH'
  | 'SOURCE_SET_DIVERGENCE';

/** The full closed set — one source of truth for the DB CHECK + tests. */
export const CANONICAL_MATCH_CLASSES: readonly CanonicalMatchClass[] = [
  'CANONICAL_EXACT',
  'ALIAS_EQUIVALENT',
  'CANONICAL_DIFFERENCE',
  'UNRESOLVED_TALENT',
  'UNRESOLVED_REQUISITION',
  'UNRESOLVED_BOTH',
  'SOURCE_SET_DIVERGENCE',
];

/** A talent's canonical view of one declared skill (talent-evidence 1G cols). */
export interface NormalizedTalentSkill {
  norm: string; // normalizeSkillSurfaceForm(surface_form) — caller-supplied
  canonical_skill_id: string | null;
}

/** A requisition critical requirement's canonical view (1D cols). */
export interface NormalizedCriticalRequirement {
  norm: string; // normalizeSkillSurfaceForm(raw_surface_form) — caller-supplied
  raw_surface_form: string; // preserved verbatim for the observation row
  canonical_skill_id: string | null;
}

/** One shadow observation row (persisted append-only; NEVER on a response). */
export interface ShadowObservation {
  match_class: CanonicalMatchClass;
  requisition_surface_form: string | null; // null only for SOURCE_SET_DIVERGENCE
  requisition_canonical_skill_id: string | null;
  talent_canonical_skill_id: string | null;
}

// Classify ONE critical requirement against the FULL talent canonical set. The two
// axes are independent: name-match (authoritative matcher) and canonical-match
// (same canonical id anywhere in the talent set, regardless of surface form).
// Returns null only when the talent has NO counterpart on EITHER axis (it genuinely
// lacks the skill — the authoritative matcher already reflects that; no shadow class).
export function classifyCriticalSkill(
  req: NormalizedCriticalRequirement,
  talentSkills: readonly NormalizedTalentSkill[],
): ShadowObservation | null {
  const nameParedSkills = talentSkills.filter((t) => t.norm === req.norm);
  const nameMatch = nameParedSkills.length > 0;
  const reqResolved = req.canonical_skill_id !== null;

  // Canonical-match scans the WHOLE talent set — this is what lets the shadow find
  // a canonical match the name matcher MISSES (ALIAS_EQUIVALENT).
  const canonicalMatchSkill = reqResolved
    ? talentSkills.find((t) => t.canonical_skill_id !== null && t.canonical_skill_id === req.canonical_skill_id)
    : undefined;

  const base = {
    requisition_surface_form: req.raw_surface_form,
    requisition_canonical_skill_id: req.canonical_skill_id,
  };

  // Canonical identity AGREES.
  if (canonicalMatchSkill !== undefined) {
    return {
      ...base,
      match_class: nameMatch ? 'CANONICAL_EXACT' : 'ALIAS_EQUIVALENT',
      talent_canonical_skill_id: canonicalMatchSkill.canonical_skill_id,
    };
  }

  // No canonical agreement. Decide via the name-paired talent skill's resolution.
  const nameParedResolved = nameParedSkills.find((t) => t.canonical_skill_id !== null);

  if (reqResolved) {
    if (!nameMatch) return null; // no name pairing + no canonical match → talent lacks it.
    if (nameParedResolved !== undefined) {
      // Name matcher pairs them, both resolved, but to DIFFERENT canonical ids.
      return { ...base, match_class: 'CANONICAL_DIFFERENCE', talent_canonical_skill_id: nameParedResolved.canonical_skill_id };
    }
    // Requisition resolved, the name-paired talent skill is unresolved.
    return { ...base, match_class: 'UNRESOLVED_TALENT', talent_canonical_skill_id: null };
  }

  // Requisition UNRESOLVED.
  if (!nameMatch) return null; // nothing to compare on either axis.
  if (nameParedResolved !== undefined) {
    return { ...base, match_class: 'UNRESOLVED_REQUISITION', talent_canonical_skill_id: nameParedResolved.canonical_skill_id };
  }
  return { ...base, match_class: 'UNRESOLVED_BOTH', talent_canonical_skill_id: null };
}

// Set-level integrity check: the derived RequisitionSkillRequirement(critical)
// surface set MUST mirror the authored GoldenProfile.critical_skills. A mismatch
// means the 1D reconcile is stale (confirmProfile ran but reconcile did not, or
// critical_skills were edited since) → one SOURCE_SET_DIVERGENCE observation.
export function computeSourceSetDivergence(
  requirementNorms: readonly string[],
  goldenCriticalNorms: readonly string[],
): ShadowObservation | null {
  const a = new Set(requirementNorms);
  const b = new Set(goldenCriticalNorms);
  const congruent = a.size === b.size && [...a].every((x) => b.has(x));
  if (congruent) return null;
  return {
    match_class: 'SOURCE_SET_DIVERGENCE',
    requisition_surface_form: null,
    requisition_canonical_skill_id: null,
    talent_canonical_skill_id: null,
  };
}

// Compute ALL shadow observations for one examination. SOURCE_SET_DIVERGENCE
// PREEMPTS per-skill classification: when the authored critical set and the derived
// 1D critical set are not congruent, the canonical input substrate is untrustworthy,
// so we emit only the divergence signal (Gate-6 ruling).
export function computeShadowObservations(args: {
  criticalRequirements: readonly NormalizedCriticalRequirement[];
  talentSkills: readonly NormalizedTalentSkill[];
  goldenCriticalNorms: readonly string[];
}): ShadowObservation[] {
  const setDiv = computeSourceSetDivergence(
    args.criticalRequirements.map((r) => r.norm),
    args.goldenCriticalNorms,
  );
  if (setDiv !== null) return [setDiv]; // preempts per-skill classification.

  const out: ShadowObservation[] = [];
  for (const req of args.criticalRequirements) {
    const obs = classifyCriticalSkill(req, args.talentSkills);
    if (obs !== null) out.push(obs);
  }
  return out;
}
