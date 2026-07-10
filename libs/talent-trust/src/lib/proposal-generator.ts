import type { ProposalKind, ProposalTriggerKind } from './vocab.js';

// TR-12 B1 (DDR §3) — the caseworker's pure policy engine. Deterministic rules
// over Phase-2's already-derived signals, minting the DESIRED set of proposals.
// It is PURE: no I/O, no clock, no repo — it reads its inputs and returns rows.
// The impure host (TalentTrustService.generateProposalsForSubject) reads the
// signals, calls this, and upserts the result. This function NEVER invokes an
// action endpoint or service — propose-never-dispose, structural (DDR §4).
//
// Silent unless sure: a subject with fresh verification, no contradiction, and a
// verified/multi-source contact returns []. Conservative by ruling — v1 proposes
// only the three trust-side triggers; engagement-aware prioritization is exactly
// the caseworker-intelligence that waits for its own ADR-0015 amendment.

// The three v1 triggers (DDR §3):
//   RENEW_VERIFICATION    ← verified_control_stale (a slot's act aged past 365d)
//   RESOLVE_CONTRADICTION ← each open contradiction (basis = the evidence id)
//   VERIFY_CONTACT        ← single_source_only ∧ a never-verified contact slot
export interface ProposalSignals {
  single_source_only: boolean;
  verified_control_stale: boolean;
}

// One open contradiction on the subject's cluster (basis = the evidence id; the
// snapshot carries its assertion_type kind, never a value).
export interface OpenContradiction {
  evidence_id: string;
  assertion_type: string;
}

// One distinct contact slot (a deduped SubjectAnchor by kind+value). basis =
// the representative anchor row id. `has_current_verification` = a VALID
// platform-verification act exists for this value; `is_stale` = that act aged
// past the threshold (computed by the reader from collected_at, single source of
// the 365d rule). The two are mutually exclusive per slot (stale ⇒ current).
export interface VerificationSlot {
  anchor_id: string;
  anchor_kind: string; // EMAIL | PHONE
  has_current_verification: boolean;
  is_stale: boolean;
}

// A desired proposal — the pure result. The host maps this onto an upsert (which
// applies the OPEN-refresh / DISMISSED-no-op / new-basis-new-row semantics).
export interface DesiredProposal {
  kind: ProposalKind;
  trigger_kind: ProposalTriggerKind;
  basis_ref_id: string;
  basis_snapshot: Record<string, unknown>;
}

export function generateProposals(
  signals: ProposalSignals,
  openContradictions: readonly OpenContradiction[],
  verificationSlots: readonly VerificationSlot[],
): DesiredProposal[] {
  const out: DesiredProposal[] = [];

  // RESOLVE_CONTRADICTION — one per open contradiction, basis = the evidence id.
  // Gives contradictions the standalone queue they have never had (DDR §3).
  for (const c of openContradictions) {
    out.push({
      kind: 'RESOLVE_CONTRADICTION',
      trigger_kind: 'OPEN_CONTRADICTION',
      basis_ref_id: c.evidence_id,
      basis_snapshot: { assertion_type: c.assertion_type },
    });
  }

  // RENEW_VERIFICATION — only when the subject's flag is set (DDR §3: the trigger
  // IS verified_control_stale), one per stale slot, basis = the anchor row id.
  if (signals.verified_control_stale) {
    for (const s of verificationSlots) {
      if (!s.is_stale) continue;
      out.push({
        kind: 'RENEW_VERIFICATION',
        trigger_kind: 'VERIFIED_CONTROL_STALE',
        basis_ref_id: s.anchor_id,
        basis_snapshot: { anchor_kind: s.anchor_kind },
      });
    }
  }

  // VERIFY_CONTACT — thinness is the demand signal (DDR §3): single_source_only
  // AND a never-verified contact slot. One per never-verified slot, basis = the
  // anchor row id. No ATS-side reads in v1 (engagement-aware prioritization waits
  // for its amendment).
  if (signals.single_source_only) {
    for (const s of verificationSlots) {
      if (s.has_current_verification) continue;
      out.push({
        kind: 'VERIFY_CONTACT',
        trigger_kind: 'SINGLE_SOURCE_ONLY',
        basis_ref_id: s.anchor_id,
        basis_snapshot: { anchor_kind: s.anchor_kind },
      });
    }
  }

  return out;
}
