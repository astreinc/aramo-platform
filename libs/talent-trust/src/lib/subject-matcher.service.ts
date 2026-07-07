import { Injectable, Logger } from '@nestjs/common';

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

// TR-6 B1 (DDR §4) — the promiscuous-value guard. A (kind, value) shared by more
// than FAN_OUT_CAP ACTIVE-fixpoint subjects generates O(K²) advisories that bury
// real signal: an identifier shared by 20+ people has lost its identifying power
// (a placeholder / shared mailbox). Above the cap the value contributes NO pairwise
// advisories; the occurrence is logged (kind + count, NEVER the value). Engine
// constant, not tenant config. Split-bias is unaffected — the guard mints no
// merges, it declines to warn on a non-signal.
export const FAN_OUT_CAP = 20;

@Injectable()
export class SubjectMatcherService {
  private readonly logger = new Logger(SubjectMatcherService.name);

  constructor(private readonly repo: TalentTrustRepository) {}

  // Detect + record advisories for ONE subject: find every OTHER in-tenant subject
  // sharing an anchor, classify the pair, and upsert the advisory. Returns the
  // advisories touched (created or refreshed). Takes NO merge action.
  //
  // TR-6 B1 (DDR §2/§3) — D2 fixpoint-correct keying + D3 fan-out guard land HERE,
  // at the matcher core, so the sweep, the CLI, AND the B2 inline hand-off
  // (recordSourcedArrival → matchSubject) all inherit both fixes.
  //   D2: every sharer subject maps to its ACTIVE fixpoint before classify/upsert;
  //       the classified pair is always ACTIVE↔ACTIVE; both sides mapping to one
  //       survivor is a self-pair and is skipped. Anchors stay ORIGIN-keyed and
  //       ORIGIN-read (the identity evidence is the husk's — I10 untouched); only
  //       the advisory KEYING normalizes to survivors.
  //   D3: a value with > FAN_OUT_CAP active-fixpoint sharers contributes nothing.
  async matchSubject(
    tenantId: string,
    subjectId: string,
    corroboratorConflicts?: CorroboratorConflictsByTarget,
  ): Promise<SubjectMatchAdvisoryRow[]> {
    const mine = await this.repo.listAnchorsBySubject(subjectId);
    if (mine.length === 0) return [];

    // D2 — resolve the ACTIVE fixpoint of any subject once, memoized. null when the
    // chain is anomalous (cycle/limit/dead-end) — such a sharer contributes no pair.
    const fpCache = new Map<string, string | null>();
    const activeOf = async (id: string): Promise<string | null> => {
      const cached = fpCache.get(id);
      if (cached !== undefined) return cached;
      const fp = await this.repo.resolveActiveFixpoint(id);
      const active = fp.kind === 'ACTIVE' ? fp.subjectId : null;
      fpCache.set(id, active);
      return active;
    };

    // The subject being matched maps to its own survivor. If it has no ACTIVE
    // fixpoint there is nothing to key an advisory to.
    const selfActive = await activeOf(subjectId);
    if (selfActive === null) return [];

    // For each of my anchor VALUES: collect the OTHER origins sharing it, but
    // guard the value on its ACTIVE-fixpoint sharer count (D3). Origins are kept
    // so classification reads the husk's (origin) anchors — the identity evidence.
    const otherOrigins = new Set<string>();
    for (const anchor of mine) {
      const rows = await this.repo.findAnchorsByValue(
        tenantId,
        anchor.anchor_kind,
        anchor.normalized_value,
      );
      // Distinct ACTIVE fixpoints sharing this value (INCLUDING self — it is one of
      // the sharers). This is K: the value's identifying-power denominator.
      const distinctActive = new Set<string>();
      const originsThisValue: string[] = [];
      for (const r of rows) {
        const active = await activeOf(r.subject_id);
        if (active === null) continue;
        distinctActive.add(active);
        if (r.subject_id !== subjectId && active !== selfActive) {
          originsThisValue.push(r.subject_id);
        }
      }
      if (distinctActive.size > FAN_OUT_CAP) {
        // Log kind + count, NEVER the value (PII discipline). One line per capped
        // value. The value mints zero advisories.
        this.logger.warn(
          `match_fan_out_capped anchor_kind=${anchor.anchor_kind} ` +
            `active_sharer_count=${distinctActive.size} cap=${FAN_OUT_CAP}`,
        );
        continue;
      }
      for (const origin of originsThisValue) otherOrigins.add(origin);
    }

    const out: SubjectMatchAdvisoryRow[] = [];
    // Dedup by the fixpoint PAIR: two husks of the same survivor sharing anchors
    // with me collapse to one (selfActive, otherActive) advisory.
    const keyedPairs = new Set<string>();
    // Deterministic iteration order (sorted) so a re-run touches advisories in a
    // stable sequence.
    for (const otherOrigin of [...otherOrigins].sort()) {
      const otherActive = await activeOf(otherOrigin);
      // Self-pair (both fixpoint to one survivor) or anomalous chain → skip.
      if (otherActive === null || otherActive === selfActive) continue;
      const pairKey =
        selfActive < otherActive
          ? `${selfActive}|${otherActive}`
          : `${otherActive}|${selfActive}`;
      if (keyedPairs.has(pairKey)) continue;
      keyedPairs.add(pairKey);

      // ORIGIN-read: classify on the origin subjects' own anchors (I10); the
      // advisory is KEYED to the two survivors.
      const theirs = await this.repo.listAnchorsBySubject(otherOrigin);
      const advisory = await this.classifyAndUpsert(
        tenantId,
        selfActive,
        mine,
        otherActive,
        theirs,
        corroboratorConflicts?.get(otherActive),
      );
      if (advisory !== null) out.push(advisory);
    }
    return out;
  }

  // Callable engine keyed by an external ref (e.g. the ATS TalentRecord.id) — resolves
  // the subject WITHOUT following a merge pointer (anchors are keyed to the ORIGIN
  // subject), then matches it. Returns [] when the ref has no subject yet.
  // TR-2a-B3a (DDR-3 §2.3/§5) — INTENTIONAL NON-FOLLOWER at the REF-resolution
  // step: resolve the ref to its ORIGIN subject (findSubjectByRef), NOT its
  // fixpoint — the identity evidence (anchors) lives on the origin, and resolving
  // the ref to the survivor would read the survivor's anchors and miss the husk's
  // same-human link. (Distinct from TR-6 B1 D2, which normalizes only the advisory
  // KEYING to survivors inside matchSubject while still reading origin anchors.)
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
