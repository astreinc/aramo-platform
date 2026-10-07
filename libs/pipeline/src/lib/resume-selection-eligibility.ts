// Resume Revision Lifecycle §9 — the SINGLE owner of the business question:
//   "Is the resume edition currently selected for this requisition eligible to be
//    used for a NEW client submittal?"
//
// This rule is interpreted in exactly ONE place. Both consumers call it and
// consume the SAME answer — never their own interpretation of "archived":
//   • the Pipeline resume view → the FE "requires attention" signal, and
//   • the Submittal authority (submitToClient) → the hard submit refusal.
//
// ACTIVE            → eligible.
// ARCHIVED/retracted → ineligible (the recruiter must replace it before handoff;
//                      the system never silently switches to another revision, §9).
// nothing selected  → none (a DISTINCT "selection required" condition, not this
//                      rule's concern — the caller maps it to its own refusal).
//
// A historical Submittal that already froze its edition is unaffected: freeze is a
// separate, immutable snapshot (§7); this gate governs only NEW handoffs.

export type ResumeSelectionEligibility =
  | { readonly status: 'eligible'; readonly lifecycle_status: 'active' }
  | { readonly status: 'none'; readonly lifecycle_status: null }
  | { readonly status: 'ineligible'; readonly lifecycle_status: string };

export function resumeSelectionEligibility(
  selectedEditionId: string | null,
  selectedLifecycleStatus: string | null,
): ResumeSelectionEligibility {
  if (selectedEditionId === null) {
    return { status: 'none', lifecycle_status: null };
  }
  if (selectedLifecycleStatus === 'active') {
    return { status: 'eligible', lifecycle_status: 'active' };
  }
  // Selected, but no longer active (archived/retracted) — or the referenced edition
  // is unresolvable. Either way it is NOT eligible for a new client submittal.
  return { status: 'ineligible', lifecycle_status: selectedLifecycleStatus ?? 'unknown' };
}
