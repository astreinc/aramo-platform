import { ANCHOR_KINDS, type AnchorKind, type MatchAdviseBand } from './vocab.js';

// TR-2a-2 within-tenant same-human MATCH CLASSIFIER — pure, no I/O, DETERMINISTIC
// (no LLM, Decision 10). Mirrors the band-derivation / strength pure-core pattern:
// the service loads anchors from the ledger and this function decides the advisory.
//
// Given the two subjects' anchor sets (already ordered canonically — `a` is the
// subject with the string-lower id, `b` the higher), it decides whether the pair is
// a same-human MATCH and, if so, classifies it:
//   - SHARED anchors: a (kind, value) present on BOTH subjects. Any share ⇒ match.
//   - BAND (R4, split-biased/inclusive): one shared anchor ⇒ ADVISE_WEAK; multiple
//     (or multi-kind) shared anchors ⇒ ADVISE_STRONG. Advisory metadata only — gates
//     nothing (advise-only slice; nothing merges).
//   - CONTRADICTION (R5): a kind BOTH subjects carry but with NO overlapping value
//     (e.g. same email, different phone) ⇒ that kind is a contradiction. Lowers
//     reviewer confidence. Split-bias earning its keep.
//
// PII discipline (R3): the returned shared refs carry only the anchor_kind + the two
// SubjectAnchor row ids — NEVER the normalized_value. Matching happens on the value
// internally, but the classification a caller PERSISTS is PII-free.

// One subject's anchor, as the classifier needs it (a SubjectAnchor row projection).
export interface AnchorForMatch {
  anchor_id: string;
  anchor_kind: AnchorKind;
  normalized_value: string;
}

// A PII-free reference to a shared anchor: the kind + the two SubjectAnchor row ids
// (a_anchor_id from subject a, b_anchor_id from subject b). No normalized_value.
export interface SharedAnchorRef {
  anchor_kind: AnchorKind;
  a_anchor_id: string;
  b_anchor_id: string;
}

export interface MatchClassification {
  shared: SharedAnchorRef[];
  contradiction_kinds: AnchorKind[];
  advise_band: MatchAdviseBand;
  has_contradiction: boolean;
}

// Classify the pair. Returns null when the two subjects share NO anchor (not a
// same-human match → no advisory). Deterministic: iterates ANCHOR_KINDS in their
// fixed vocabulary order and sorts shared refs, so identical input ⇒ identical output.
export function classifyPair(
  aAnchors: readonly AnchorForMatch[],
  bAnchors: readonly AnchorForMatch[],
): MatchClassification | null {
  const shared: SharedAnchorRef[] = [];
  const contradictionKinds: AnchorKind[] = [];

  for (const kind of ANCHOR_KINDS) {
    const aOfKind = aAnchors.filter((x) => x.anchor_kind === kind);
    const bOfKind = bAnchors.filter((x) => x.anchor_kind === kind);
    // A kind is only comparable when BOTH subjects carry it.
    if (aOfKind.length === 0 || bOfKind.length === 0) continue;

    const sharedOfKind: SharedAnchorRef[] = [];
    for (const av of aOfKind) {
      const bv = bOfKind.find((x) => x.normalized_value === av.normalized_value);
      if (bv !== undefined) {
        sharedOfKind.push({ anchor_kind: kind, a_anchor_id: av.anchor_id, b_anchor_id: bv.anchor_id });
      }
    }

    if (sharedOfKind.length > 0) {
      // Deterministic order within a kind: by a_anchor_id.
      sharedOfKind.sort((x, y) => (x.a_anchor_id < y.a_anchor_id ? -1 : x.a_anchor_id > y.a_anchor_id ? 1 : 0));
      shared.push(...sharedOfKind);
    } else {
      // Both subjects carry this kind but no value overlaps → contradiction (R5).
      contradictionKinds.push(kind);
    }
  }

  if (shared.length === 0) return null;

  // R4 — one shared anchor is WEAK; multiple (incl. multi-kind, which is ≥2) is STRONG.
  const advise_band: MatchAdviseBand = shared.length >= 2 ? 'ADVISE_STRONG' : 'ADVISE_WEAK';

  return {
    shared,
    contradiction_kinds: contradictionKinds,
    advise_band,
    has_contradiction: contradictionKinds.length > 0,
  };
}
