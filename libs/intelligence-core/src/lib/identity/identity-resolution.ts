import type { ResolutionRule } from '@aramo/intelligence-contracts';

import { canonicalJson, namesConflict, sha256Hex, type NameSnapshot } from '../normalize.js';
import type { IdentityConflictType, IdentifierType } from '../vocabulary.js';

// ATI-SEP-1 T3 (ADR-0036 §5) — the PURE identity-resolution decision. No I/O:
// the service gathers the facts, this function applies rules R1–R5, the service
// applies the decision. Unit-tested exhaustively (identity-resolution.spec.ts).
//
//   R1  An existing (source_system_id, source_tenant_id, external_talent_id) is
//       authoritative → same subject. A material identity change (every verified
//       anchor differs AND the names differ) → REFERENCE_IDENTITY_MUTATION, still
//       the same subject.
//   R2  A VERIFIED email / phone / gov token matching an ACTIVE VERIFIED
//       identifier of exactly one subject → that subject (primary / secondary
//       position is irrelevant). Matches on >1 distinct subjects → NO merge: a
//       new PROVISIONAL subject + an ANCHOR_CONTRADICTION naming all of them.
//   R3  Unverified matches never link (they are not even consulted here).
//   R4  Same verified anchor, conflicting name → same subject +
//       IDENTITY_ATTRIBUTE_CONFLICT (never labelled fraud).
//   R5  No verified match → a new PROVISIONAL subject.

/** `TYPE:normalized_value` — the identifier key used in snapshots and matching. */
export function identifierKey(type: IdentifierType, normalizedValue: string): string {
  return `${type}:${normalizedValue}`;
}

/** Stored as ExternalTalentReference.last_identity_snapshot (GOV_ID as token only). */
export interface IdentitySnapshot {
  names: NameSnapshot;
  verified: string[];
  unverified: string[];
}

export interface VerifiedAnchorMatch {
  key: string;
  /** The surviving subject (merge chains already followed). */
  subject_id: string;
}

export interface ResolutionFacts {
  request: IdentitySnapshot;
  existing_reference: { id: string; subject_id: string; snapshot: IdentitySnapshot | null } | null;
  verified_matches: VerifiedAnchorMatch[];
  /** Known names per matched subject (from its references' snapshots). */
  subject_names: Record<string, NameSnapshot[]>;
}

export interface PlannedConflict {
  conflict_type: IdentityConflictType;
  related_subject_ids: string[];
  details: Record<string, unknown> & { signature: string };
}

export interface ResolutionDecision {
  rule: ResolutionRule;
  /** null → create a new PROVISIONAL subject. */
  subject_id: string | null;
  /** R2 link onto an existing subject (a second, independent verified source). */
  linked_by_verified_anchor: boolean;
  /** Conflicts to open on the resolved (or new) subject. */
  conflicts: PlannedConflict[];
}

function signed(conflict_type: IdentityConflictType, related: string[], details: Record<string, unknown>): PlannedConflict {
  const related_subject_ids = [...new Set(related)].sort();
  const signature = sha256Hex(canonicalJson({ conflict_type, related_subject_ids, ...details }));
  return { conflict_type, related_subject_ids, details: { ...details, signature } };
}

function distinctSubjects(matches: VerifiedAnchorMatch[]): string[] {
  return [...new Set(matches.map((m) => m.subject_id))].sort();
}

function keysBySubject(matches: VerifiedAnchorMatch[], subjectId: string): string[] {
  return [...new Set(matches.filter((m) => m.subject_id === subjectId).map((m) => m.key))].sort();
}

/** R1 — every verified anchor differs (both sides carry some) AND the names differ. */
export function isMaterialIdentityChange(prev: IdentitySnapshot, next: IdentitySnapshot): boolean {
  if (prev.verified.length === 0 || next.verified.length === 0) return false;
  const prevSet = new Set(prev.verified);
  const anchorsDiffer = next.verified.every((k) => !prevSet.has(k));
  return anchorsDiffer && namesConflict(prev.names, next.names);
}

export function decideResolution(facts: ResolutionFacts): ResolutionDecision {
  const { request, existing_reference: ref, verified_matches: matches } = facts;

  // R1 — the reference is authoritative.
  if (ref !== null) {
    const conflicts: PlannedConflict[] = [];
    if (ref.snapshot !== null && isMaterialIdentityChange(ref.snapshot, request)) {
      conflicts.push(
        signed('REFERENCE_IDENTITY_MUTATION', [], {
          reference_id: ref.id,
          previous_verified: ref.snapshot.verified,
          next_verified: request.verified,
          previous_names: ref.snapshot.names,
          next_names: request.names,
        }),
      );
    }
    // A verified anchor of this reference bound to ANOTHER subject: never merge,
    // never re-bind — surface it for review.
    const others = distinctSubjects(matches).filter((s) => s !== ref.subject_id);
    if (others.length > 0) {
      conflicts.push(
        signed('ANCHOR_CONTRADICTION', others, {
          reference_id: ref.id,
          anchors: [...new Set(matches.filter((m) => m.subject_id !== ref.subject_id).map((m) => m.key))].sort(),
        }),
      );
    }
    return { rule: 'EXISTING_REFERENCE', subject_id: ref.subject_id, linked_by_verified_anchor: false, conflicts };
  }

  const subjects = distinctSubjects(matches);

  // R2 (contradiction) — verified anchors point at more than one subject.
  if (subjects.length > 1) {
    return {
      rule: 'ANCHOR_CONTRADICTION',
      subject_id: null,
      linked_by_verified_anchor: false,
      conflicts: [
        signed('ANCHOR_CONTRADICTION', subjects, {
          anchors_by_subject: Object.fromEntries(subjects.map((s) => [s, keysBySubject(matches, s)])),
        }),
      ],
    };
  }

  // R2 — exactly one subject.
  if (subjects.length === 1) {
    const subjectId = subjects[0] as string;
    const known = facts.subject_names[subjectId] ?? [];
    const conflicts: PlannedConflict[] = [];
    // R4 — the verified anchor wins; a name that matches none of the subject's
    // known names is an attribute conflict for review.
    if (known.length > 0 && known.every((n) => namesConflict(n, request.names))) {
      conflicts.push(
        signed('IDENTITY_ATTRIBUTE_CONFLICT', [], {
          attribute: 'name',
          anchors: keysBySubject(matches, subjectId),
          incoming_names: request.names,
        }),
      );
    }
    return { rule: 'VERIFIED_ANCHOR', subject_id: subjectId, linked_by_verified_anchor: true, conflicts };
  }

  // R3 + R5 — unverified data never links: a new PROVISIONAL subject.
  return { rule: 'NEW_PROVISIONAL', subject_id: null, linked_by_verified_anchor: false, conflicts: [] };
}
