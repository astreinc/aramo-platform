import { isConfirmingAnchor } from './anchor-confirmation.js';
import {
  ANCHOR_KINDS,
  SOURCE_CLASSES,
  type AnchorKind,
  type MatchAdviseBand,
  type SourceClass,
} from './vocab.js';

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
  // TR-2a-B2 (DDR-2 §4) — the anchor's attestation level. A shared (kind, value)
  // whose strongest class on BOTH sides is confirming lists the kind in
  // confirmed_kinds and forces ADVISE_STRONG.
  source_class: SourceClass;
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
  // TR-2a-B2 (DDR-2 §4) — kinds shared with BOTH sides confirming-class. Forces
  // ADVISE_STRONG; PII-free (kind labels only). A strictly-stronger re-open key.
  confirmed_kinds: AnchorKind[];
  advise_band: MatchAdviseBand;
  has_contradiction: boolean;
}

// Strongest source_class among a group of anchors (SOURCE_CLASSES is ordered
// worthless -> authoritative, so the max index wins). The group is non-empty.
function strongestClass(anchors: readonly AnchorForMatch[]): SourceClass {
  let best = anchors[0]!.source_class;
  for (const a of anchors) {
    if (SOURCE_CLASSES.indexOf(a.source_class) > SOURCE_CLASSES.indexOf(best)) {
      best = a.source_class;
    }
  }
  return best;
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
  const confirmedKinds: AnchorKind[] = [];

  for (const kind of ANCHOR_KINDS) {
    const aOfKind = aAnchors.filter((x) => x.anchor_kind === kind);
    const bOfKind = bAnchors.filter((x) => x.anchor_kind === kind);
    // A kind is only comparable when BOTH subjects carry it.
    if (aOfKind.length === 0 || bOfKind.length === 0) continue;

    const sharedOfKind: SharedAnchorRef[] = [];
    let confirmedBothThisKind = false;
    // Group by value (B1's extended key admits >1 class-row per value) so a
    // shared VALUE is ONE shared identity signal regardless of class-row count.
    const seenValues = new Set<string>();
    for (const av of aOfKind) {
      if (seenValues.has(av.normalized_value)) continue;
      const bForValue = bOfKind.filter((x) => x.normalized_value === av.normalized_value);
      if (bForValue.length === 0) continue;
      seenValues.add(av.normalized_value);
      const aForValue = aOfKind.filter((x) => x.normalized_value === av.normalized_value);
      const aStrong = strongestClass(aForValue);
      const bStrong = strongestClass(bForValue);
      // Deterministic representative ids: the strongest-class anchor per side.
      const aRep = aForValue.find((x) => x.source_class === aStrong) ?? aForValue[0]!;
      const bRep = bForValue.find((x) => x.source_class === bStrong) ?? bForValue[0]!;
      sharedOfKind.push({ anchor_kind: kind, a_anchor_id: aRep.anchor_id, b_anchor_id: bRep.anchor_id });
      // Confirming-BOTH on this value (strongest class per side).
      if (isConfirmingAnchor(kind, aStrong) && isConfirmingAnchor(kind, bStrong)) {
        confirmedBothThisKind = true;
      }
    }

    if (sharedOfKind.length > 0) {
      // Deterministic order within a kind: by a_anchor_id.
      sharedOfKind.sort((x, y) => (x.a_anchor_id < y.a_anchor_id ? -1 : x.a_anchor_id > y.a_anchor_id ? 1 : 0));
      shared.push(...sharedOfKind);
      if (confirmedBothThisKind) confirmedKinds.push(kind);
    } else {
      // Both subjects carry this kind but no value overlaps → contradiction (R5).
      contradictionKinds.push(kind);
    }
  }

  if (shared.length === 0) return null;

  // R4 — one shared anchor is WEAK; multiple (incl. multi-kind, ≥2) is STRONG.
  // B2 (DDR-2 §4): any confirming-both shared ref forces STRONG regardless of count.
  const advise_band: MatchAdviseBand =
    shared.length >= 2 || confirmedKinds.length > 0 ? 'ADVISE_STRONG' : 'ADVISE_WEAK';

  return {
    shared,
    contradiction_kinds: contradictionKinds,
    confirmed_kinds: confirmedKinds,
    advise_band,
    has_contradiction: contradictionKinds.length > 0,
  };
}
