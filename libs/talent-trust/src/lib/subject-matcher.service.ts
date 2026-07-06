import { Injectable } from '@nestjs/common';

import {
  classifyPair,
  type AnchorForMatch,
} from './match-classification.js';
import {
  TalentTrustRepository,
  type SubjectAnchorRow,
  type SubjectMatchAdvisoryRow,
} from './talent-trust.repository.js';
import type {
  CorroboratorConflictKind,
  ResolutionSubjectRefType,
} from './vocab.js';

// TR-2a-B2 — resolver-contributed strong-corroborator conflicts, keyed by the
// OTHER subject id in the pair. A CONFIRMED-arm NAME demotion passes
// { <targetId> => ['NAME'] } so the hand-off advisory for that specific pair
// carries corroborator_conflict_kinds. Absent → no corroborator conflict.
export type CorroboratorConflictsByTarget = ReadonlyMap<
  string,
  CorroboratorConflictKind[]
>;

// SubjectMatcherService — TR-2a-2 WITHIN-TENANT SAME-HUMAN MATCHER (ADVISE-ONLY).
//
// It DETECTS pairs of ResolutionSubjects in the SAME tenant that a human should
// review as possibly the same person (they share a normalized SubjectAnchor) and
// WRITES an advisory (SubjectMatchAdvisory) for each. It takes ZERO merge action:
// no mergeSubjects call, no subject status change (R1) — so a false-merge is
// structurally impossible in this slice. Nothing auto-merges because self-declared
// shared email/phone are corroborators, not verified Tier-A anchors (R2).
//
// WALL (R6): talent_trust-INTERNAL (cip). Reads only SubjectAnchor + ResolutionSubject
// via the repository. NO ats import (I15), NO identity_index / cross-tenant (TR-2b),
// NO LLM — the classification is the deterministic pure `classifyPair` (Decision 10).
//
// Two entrypoints (RECON GATE 6): a callable engine (matchSubject / matchForRef) and a
// backfill sweep (backfillMatches). Both idempotent — the advisory's canonical-pair
// unique key means a re-run upserts, never duplicates. The write-time producer trigger
// is DEFERRED to TR-2a-3 (see the slice notes); the backfill sweep gives complete
// pairwise coverage of the current anchor set.

const CREATED_BY = 'libs/talent-trust:subject-matcher';

@Injectable()
export class SubjectMatcherService {
  constructor(private readonly repo: TalentTrustRepository) {}

  // Detect + record advisories for ONE subject: find every OTHER in-tenant subject
  // sharing an anchor, classify the pair, and upsert the advisory. Returns the
  // advisories touched (created or refreshed). Takes NO merge action.
  async matchSubject(
    tenantId: string,
    subjectId: string,
    corroboratorConflicts?: CorroboratorConflictsByTarget,
  ): Promise<SubjectMatchAdvisoryRow[]> {
    const mine = await this.repo.listAnchorsBySubject(subjectId);
    if (mine.length === 0) return [];

    // Find other in-tenant subjects: any subject sharing one of my anchor
    // values. Tenant-scoping is guaranteed by findAnchorsByValue (tenant-filtered),
    // so a cross-tenant subject can never surface here.
    const otherSubjectIds = new Set<string>();
    for (const anchor of mine) {
      const rows = await this.repo.findAnchorsByValue(
        tenantId,
        anchor.anchor_kind,
        anchor.normalized_value,
      );
      for (const r of rows) {
        if (r.subject_id !== subjectId) otherSubjectIds.add(r.subject_id);
      }
    }

    const out: SubjectMatchAdvisoryRow[] = [];
    // Deterministic iteration order (sorted) so a re-run touches advisories in a
    // stable sequence.
    for (const otherId of [...otherSubjectIds].sort()) {
      const theirs = await this.repo.listAnchorsBySubject(otherId);
      const advisory = await this.classifyAndUpsert(
        tenantId,
        subjectId,
        mine,
        otherId,
        theirs,
        corroboratorConflicts?.get(otherId),
      );
      if (advisory !== null) out.push(advisory);
    }
    return out;
  }

  // Callable engine keyed by an external ref (e.g. the ATS TalentRecord.id) — resolves
  // the subject WITHOUT following a merge pointer (anchors are keyed to the ORIGIN
  // subject), then matches it. Returns [] when the ref has no subject yet.
  async matchForRef(
    tenantId: string,
    refType: ResolutionSubjectRefType,
    refId: string,
  ): Promise<SubjectMatchAdvisoryRow[]> {
    const subject = await this.repo.findSubjectByRef(tenantId, refType, refId);
    if (subject === null) return [];
    return this.matchSubject(tenantId, subject.id);
  }

  // Backfill sweep — detect ALL current advisories across a tenant so the matcher
  // starts from a complete set (partial coverage → false-split). Idempotent: runs the
  // per-subject matcher for every anchored subject; the canonical-pair unique key
  // dedupes the A→B and B→A discoveries. Returns totals.
  async backfillMatches(
    tenantId: string,
  ): Promise<{ subjects: number; advisories: number }> {
    const subjectIds = await this.repo.listSubjectIdsWithAnchors(tenantId);
    const touched = new Set<string>();
    for (const subjectId of subjectIds) {
      const advisories = await this.matchSubject(tenantId, subjectId);
      for (const a of advisories) touched.add(a.id);
    }
    return { subjects: subjectIds.length, advisories: touched.size };
  }

  // ---- internals ------------------------------------------------------

  // Canonicalize the pair (a = string-lower subject id), classify, and upsert the
  // advisory. Returns null when the pair shares no anchor (not a match).
  private async classifyAndUpsert(
    tenantId: string,
    s1: string,
    s1Anchors: SubjectAnchorRow[],
    s2: string,
    s2Anchors: SubjectAnchorRow[],
    corroboratorConflictKinds?: CorroboratorConflictKind[],
  ): Promise<SubjectMatchAdvisoryRow | null> {
    const s1Lower = s1 < s2;
    const aId = s1Lower ? s1 : s2;
    const bId = s1Lower ? s2 : s1;
    const aAnchors = toMatchAnchors(s1Lower ? s1Anchors : s2Anchors);
    const bAnchors = toMatchAnchors(s1Lower ? s2Anchors : s1Anchors);

    const classification = classifyPair(aAnchors, bAnchors);
    if (classification === null) return null;

    return this.repo.upsertMatchAdvisory({
      tenant_id: tenantId,
      subject_a_id: aId,
      subject_b_id: bId,
      advise_band: classification.advise_band,
      has_contradiction: classification.has_contradiction,
      match_basis: {
        shared: classification.shared,
        contradiction_kinds: classification.contradiction_kinds,
        confirmed_kinds: classification.confirmed_kinds,
      },
      // Resolver-contributed (e.g. a CONFIRMED-arm NAME demotion for this pair).
      // The repo merges it into has_contradiction + match_basis.
      corroborator_conflict_kinds:
        corroboratorConflictKinds !== undefined && corroboratorConflictKinds.length > 0
          ? corroboratorConflictKinds
          : undefined,
      created_by: CREATED_BY,
    });
  }
}

function toMatchAnchors(rows: SubjectAnchorRow[]): AnchorForMatch[] {
  return rows.map((r) => ({
    anchor_id: r.id,
    anchor_kind: r.anchor_kind,
    normalized_value: r.normalized_value,
    // TR-2a-B2 (DDR-2 §4) — project source_class so classifyPair can force
    // ADVISE_STRONG + confirmed_kinds on confirming-both shared refs.
    source_class: r.source_class,
  }));
}
