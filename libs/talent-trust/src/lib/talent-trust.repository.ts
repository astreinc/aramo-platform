import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';

import { PrismaService } from './prisma/prisma.service.js';
import type { SharedAnchorRef } from './match-classification.js';
import type {
  AnchorKind,
  CorroboratorConflictKind,
  DecayProfile,
  EvidenceEventType,
  EvidenceLinkRelation,
  EvidenceStatus,
  MatchAdviseBand,
  MatchAdvisoryStatus,
  MatchResolutionAction,
  MergeOperationKind,
  Method,
  PortabilityClass,
  PresentationBand,
  SourceClass,
  TrustDimension,
  ResolutionSubjectRefType,
  ResolutionSubjectStatus,
} from './vocab.js';

// TR-2a-B2 (DDR-2 §2 pre-step) — the outcome of following merged_into pointers
// to a subject's ACTIVE fixpoint. CYCLE/LIMIT are anomalies → the resolver
// splits and logs loudly; DEAD_END is a non-ACTIVE husk with no forward pointer.
export type FixpointResult =
  | { kind: 'ACTIVE'; subjectId: string }
  | { kind: 'CYCLE' }
  | { kind: 'LIMIT' }
  | { kind: 'DEAD_END' };

// TR-2a-B2 — the PII-free advisory basis persisted on SubjectMatchAdvisory
// (kinds + anchor-row ids only; never a normalized_value). corroborator_conflict_kinds
// is resolver-contributed (e.g. a CONFIRMED-arm NAME demotion).
export interface MatchBasis {
  shared: SharedAnchorRef[];
  contradiction_kinds: AnchorKind[];
  confirmed_kinds: AnchorKind[];
  corroborator_conflict_kinds?: CorroboratorConflictKind[];
}

// Repository for the talent-trust ledger (TR-1). The Prisma boundary — all
// SQL lives here; the service composes these into the §8 interface and owns
// the TrustState recompute. UUID v7 PKs are generated app-side (Postgres 17
// has no native uuidv7(); identity/submittal/canonicalization precedent).
//
// Cross-schema rule (Architecture §7.3): the only relations are intra-schema
// (within talent_trust). External refs (ResolutionSubjectRef.ref_id, EvidenceEvent
// .linked_evidence_id, EvidenceLink.from/to) are UUID-only with no FK.

export interface EvidenceRecordRow {
  id: string;
  subject_id: string;
  tenant_id: string;
  dimension: TrustDimension;
  assertion_type: string;
  assertion_payload: unknown;
  source_class: SourceClass;
  source_ref: unknown | null;
  method: Method;
  strength: number;
  collected_at: Date;
  decay_profile: DecayProfile;
  portability_class: PortabilityClass;
  ai_derived: boolean;
  current_status: EvidenceStatus;
  created_by: string;
  created_at: Date;
}

// TR-14 B1 (DDR §2.2) — the EvidenceLink graph, made readable for the dossier
// (its first reader — previously only appendLink + the existence guard). One
// row per (from, to, relation) semantic fact: CONTRADICTS pairs, SUPERSEDES chains.
export interface EvidenceLinkRow {
  id: string;
  from_evidence_id: string;
  to_evidence_id: string;
  relation: string;
  tenant_id: string;
  created_at: Date;
}

// TR-14 B1 (DDR §2.2) — the EvidenceEvent timeline, made readable for the dossier
// (its first reader — previously append-only). The lifecycle story of one
// evidence row: what event, by whom, why, what it implicated, when.
export interface EvidenceEventRow {
  id: string;
  evidence_id: string;
  tenant_id: string;
  event_type: string;
  reason: string | null;
  linked_evidence_id: string | null;
  actor: string | null;
  occurred_at: Date;
}

export interface ResolutionSubjectRow {
  id: string;
  tenant_id: string;
  status: ResolutionSubjectStatus;
  merged_into_subject_id: string | null;
  created_at: Date;
}

// A ResolutionSubjectRef row — the (ref_type, ref_id) keying a subject to an
// external identity (ATS_TALENT_RECORD.id / PERSON_CLUSTER.id / SOURCED_TALENT
// payload_id). Promotion Gate reads these to (a) detect an existing record link
// [already-promoted no-op] and (b) find the origin SOURCED_TALENT arrival.
export interface ResolutionSubjectRefRow {
  ref_type: ResolutionSubjectRefType;
  ref_id: string;
  link_source: string;
}

// Promotion Gate Slice-B1 — a promoted subject with unreconciled evidence: the
// subject id, its tenant, and the ATS_TALENT_RECORD.id (ref_id) to enrich.
export interface ReconcileTargetRow {
  subject_id: string;
  tenant_id: string;
  talent_record_id: string;
}

// Promotion-Trigger slice B-api — one pre-promotion pool row: the subject +
// its 4 TrustState bands (null when no evidence yet) + open_contradiction_count.
export interface SourcedPoolRow {
  subject_id: string;
  created_at: Date;
  identity_band: string | null;
  claims_band: string | null;
  continuity_band: string | null;
  eligibility_band: string | null;
  open_contradiction_count: number;
}

// Promotion-Trigger slice B-api — one display-identity evidence row from the
// batched page read (FULL_NAME / EMAIL, VALID only).
export interface DisplayIdentityEvidenceRow {
  subject_id: string;
  assertion_type: string;
  assertion_payload: unknown;
}

export interface TrustStateRow {
  subject_id: string;
  tenant_id: string;
  identity_band: PresentationBand;
  claims_band: PresentationBand;
  continuity_band: PresentationBand;
  eligibility_band: PresentationBand;
  open_contradiction_count: number;
  stale_evidence_count: number;
  has_open_dispute: boolean;
  // TR-5 B2 (DDR §4) — named thinness flags (surfaced as statements, never numbers).
  single_source_only: boolean;
  longitudinal_observed: boolean;
  last_recomputed_at: Date;
}

export interface InsertEvidenceInput {
  subject_id: string;
  tenant_id: string;
  dimension: TrustDimension;
  assertion_type: string;
  assertion_payload: unknown;
  source_class: SourceClass;
  source_ref?: unknown | null;
  method: Method;
  strength: number;
  collected_at: Date;
  decay_profile: DecayProfile;
  portability_class: PortabilityClass;
  ai_derived: boolean;
  current_status: EvidenceStatus;
  created_by: string;
}

export interface SubjectAnchorRow {
  id: string;
  subject_id: string;
  tenant_id: string;
  anchor_kind: AnchorKind;
  normalized_value: string;
  source_evidence_id: string;
  // TR-2a-B1 (DDR-1 §3.2) — the minting evidence's SourceClass, projected
  // atomically inside insertAnchor. Part of the extended anchor unique key.
  source_class: SourceClass;
  created_at: Date;
}

// TR-2a-2 — the within-tenant same-human ADVISORY row (a same-human match pair).
// TR-2a-3 adds the resolution + reversal audit (all nullable until resolved).
export interface SubjectMatchAdvisoryRow {
  id: string;
  tenant_id: string;
  subject_a_id: string;
  subject_b_id: string;
  advise_band: MatchAdviseBand;
  has_contradiction: boolean;
  // { shared: SharedAnchorRef[], contradiction_kinds: AnchorKind[] } — PII-free.
  match_basis: unknown;
  status: MatchAdvisoryStatus;
  created_by: string;
  created_at: Date;
  // TR-2a-3 resolution audit.
  resolution_action: MatchResolutionAction | null;
  resolved_by: string | null;
  resolved_at: Date | null;
  resolution_justification: string | null;
  surviving_subject_id: string | null;
  merged_subject_id: string | null;
  reversed_by: string | null;
  reversed_at: Date | null;
  reversal_justification: string | null;
  // TR-2a-B2 re-open provenance (DDR-2 §5).
  reopened_at: Date | null;
  reopened_from_band: MatchAdviseBand | null;
}

// The upsert input for an advisory. Keyed by the canonical unordered pair.
export interface UpsertMatchAdvisoryInput {
  tenant_id: string;
  subject_a_id: string;
  subject_b_id: string;
  advise_band: MatchAdviseBand;
  // The anchor-based contradiction from classifyPair. The stored has_contradiction
  // = this ∪ (corroborator_conflict_kinds non-empty) — DDR-2 §4.
  has_contradiction: boolean;
  match_basis: MatchBasis;
  // TR-2a-B2 (Amendment §2.3) — resolver-contributed strong-corroborator conflicts
  // (e.g. ['NAME'] from a CONFIRMED-arm demotion). Merged into has_contradiction +
  // match_basis. A new corroborator conflict does NOT re-open a dismissed pair.
  corroborator_conflict_kinds?: CorroboratorConflictKind[];
  created_by: string;
}

// TR-2a-1 — the anchor write: the EvidenceRecord (source of truth) + its CREATED
// event + the SubjectAnchor projection, together in one transaction.
export interface InsertAnchorInput {
  evidence: InsertEvidenceInput;
  anchor_kind: AnchorKind;
  normalized_value: string;
}

// TR-3 B2 (§3.1/§3.2) — a VerificationRequest row (the T3-B1 writer-less table
// gains its writer here). status ∈ PENDING | CONFIRMED | EXPIRED; consumed_at
// non-null is the single-use marker (stamped LAST under the replay-guarded
// confirm). token_hash is sha256(raw).base64url — the raw is never stored.
export interface VerificationRequestRow {
  id: string;
  tenant_id: string;
  talent_record_id: string;
  subject_id: string;
  anchor_kind: AnchorKind;
  normalized_value: string;
  token_hash: string;
  status: 'PENDING' | 'CONFIRMED' | 'EXPIRED';
  created_by: string;
  created_at: Date;
  expires_at: Date;
  consumed_at: Date | null;
}

export interface CreateVerificationRequestInput {
  tenant_id: string;
  talent_record_id: string;
  subject_id: string;
  anchor_kind: AnchorKind;
  normalized_value: string;
  token_hash: string;
  created_by: string;
  expires_at: Date;
}

// TR-2a-B3b (DDR-3 §6) — one recorded ref-normalization action (verbatim, so
// reversal restores topology exactly). `re_homed` = the ref's subject_id moved
// from→to; `removed` = the ref row was deleted (its linkage copied here first).
export interface RefActionRecord {
  kind: 're_homed' | 'removed';
  ref_type: ResolutionSubjectRefType;
  ref_id: string;
  from_subject_id: string;
  to_subject_id: string | null;
  linked_at: string;
  link_source: string;
}

// TR-2a-B3b — one per-domain sweep step, appended as the orchestrator checkpoints.
export interface SweepStepRecord {
  domain: string;
  status: 'done';
  repointed_ids: string[];
  removed_rows: unknown[];
}

// TR-2a-B3b — a collision row removed with its FULL pre-removal content.
export interface CollisionRecord {
  domain: string;
  row: unknown;
}

// TR-2a-B3b — the SubjectMergeOperation row (DDR-3 §6).
export interface SubjectMergeOperationRow {
  id: string;
  tenant_id: string;
  // TR-6 B1 (DDR §5) — RECONCILE (orchestrator) vs DIRECT_MERGE/DIRECT_UNMERGE.
  kind: MergeOperationKind;
  // TR-6 B1 (DDR §5) — the direct merge/unmerge actor + reason (the formerly-voided
  // string). Null on reconcile-driven rows (their trail is the advisory + reversal).
  actor: string | null;
  reason: string | null;
  advisory_id: string | null;
  surviving_subject_id: string;
  merged_subject_id: string;
  surviving_record_id: string | null;
  superseded_record_id: string | null;
  status: 'PENDING' | 'COMPLETED' | 'REVERSED';
  ref_actions: RefActionRecord[];
  sweep_steps: SweepStepRecord[];
  collision_records: CollisionRecord[];
  started_at: Date;
  completed_at: Date | null;
  reversed_at: Date | null;
  reversed_by: string | null;
  reversal_justification: string | null;
  post_merge_accretions: unknown | null;
}

@Injectable()
export class TalentTrustRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ---- ResolutionSubject + ref keying -------------------------------------

  async findSubjectByRef(
    tenantId: string,
    refType: ResolutionSubjectRefType,
    refId: string,
  ): Promise<ResolutionSubjectRow | null> {
    const ref = await this.prisma.resolutionSubjectRef.findUnique({
      where: { tenant_id_ref_type_ref_id: { tenant_id: tenantId, ref_type: refType, ref_id: refId } },
      include: { subject: true },
    });
    return ref ? (ref.subject as ResolutionSubjectRow) : null;
  }

  async findSubjectById(id: string): Promise<ResolutionSubjectRow | null> {
    const row = await this.prisma.resolutionSubject.findUnique({ where: { id } });
    return (row as ResolutionSubjectRow | null) ?? null;
  }

  // TR-2a-B2 (DDR-2 §2 pre-step) — follow merged_into_subject_id iteratively to
  // the subject's ACTIVE fixpoint. Bounded (guard limit) + cycle-guarded (seen
  // set). An arrival must never attach to a MERGED husk, and must not stop one
  // hop short on an A→B→C chain. B3 generalizes this to every reader; B2 wires
  // the RESOLVER only. Cycle/limit → the resolver splits (logs loudly).
  async resolveActiveFixpoint(startSubjectId: string): Promise<FixpointResult> {
    const LIMIT = 64;
    const seen = new Set<string>();
    let currentId = startSubjectId;
    for (let hops = 0; hops <= LIMIT; hops++) {
      if (seen.has(currentId)) return { kind: 'CYCLE' };
      seen.add(currentId);
      const subject = await this.findSubjectById(currentId);
      // A pointer to a non-existent subject, or a non-ACTIVE husk with no forward
      // pointer, is a dead end (anomalous — a husk should always point forward).
      if (subject === null) return { kind: 'DEAD_END' };
      if (subject.status === 'ACTIVE') return { kind: 'ACTIVE', subjectId: subject.id };
      if (subject.merged_into_subject_id === null) return { kind: 'DEAD_END' };
      currentId = subject.merged_into_subject_id;
    }
    return { kind: 'LIMIT' };
  }

  // TR-2a-B3a (DDR-3 §5) — the cluster members of a surviving subject: the
  // survivor itself PLUS every subject whose merged_into chain resolves to it
  // (reverse-reachability over merged_into edges). Bounded + cycle-safe (the
  // `members` set dedupes, so a pointer cycle terminates). Multi-level chains
  // fold in: A→B→C returns {C,B,A} when called with C. The union READ layer
  // (getEvidence / recompute) uses this to heal the stranded-evidence strand at
  // read time WITHOUT moving any evidence (evidence stays origin-keyed, §2.3).
  async clusterMembers(survivingSubjectId: string): Promise<string[]> {
    const LIMIT = 4096;
    const members = new Set<string>([survivingSubjectId]);
    let frontier = [survivingSubjectId];
    while (frontier.length > 0 && members.size <= LIMIT) {
      const children = await this.prisma.resolutionSubject.findMany({
        where: { merged_into_subject_id: { in: frontier } },
        select: { id: true },
      });
      const next: string[] = [];
      for (const c of children) {
        if (!members.has(c.id)) {
          members.add(c.id);
          next.push(c.id);
        }
      }
      frontier = next;
    }
    return [...members];
  }

  // Resolve-or-create the ResolutionSubject for a ref (recordEvidence §8). One ref
  // → one subject within a tenant (the unique constraint). Returns the
  // subject id.
  // TR-2a-B3a (DDR-3 §2.3/§5) — INTENTIONAL NON-FOLLOWER (write-side, origin-
  // keyed by design): a write lands on the ORIGIN subject of its ref, never a
  // merge fixpoint. Cluster-union READS (§5) surface it on the survivor — a
  // write on a merged husk is not stranded, and it is exactly where provenance
  // says it belongs. Do NOT add fixpoint-following here.
  async resolveOrCreateSubject(
    tenantId: string,
    refType: ResolutionSubjectRefType,
    refId: string,
    linkSource: string,
  ): Promise<string> {
    const existing = await this.findSubjectByRef(tenantId, refType, refId);
    if (existing) return existing.id;

    const subjectId = uuidv7();
    await this.prisma.resolutionSubject.create({
      data: { id: subjectId, tenant_id: tenantId, status: 'ACTIVE' },
    });
    await this.prisma.resolutionSubjectRef.create({
      data: {
        id: uuidv7(),
        subject_id: subjectId,
        tenant_id: tenantId,
        ref_type: refType,
        ref_id: refId,
        link_source: linkSource,
      },
    });
    return subjectId;
  }

  // List a subject's external refs (Promotion Gate). One subject → many refs
  // (SOURCED_TALENT on cold-ingest, plus ATS_TALENT_RECORD once promoted).
  async listRefsBySubject(subjectId: string): Promise<ResolutionSubjectRefRow[]> {
    const rows = await this.prisma.resolutionSubjectRef.findMany({
      where: { subject_id: subjectId },
      select: { ref_type: true, ref_id: true, link_source: true },
      orderBy: { linked_at: 'asc' },
    });
    return rows.map((r) => ({
      ref_type: r.ref_type as ResolutionSubjectRefType,
      ref_id: r.ref_id,
      link_source: r.link_source,
    }));
  }

  // Attach a NEW ref to an ALREADY-EXISTING subject (Promotion Gate's link
  // step). DISTINCT from resolveOrCreateSubject, which mints a subject when the
  // ref is absent — here the subject is known and we point a ref at it (the
  // promotion links the cold-ingest subject to the newly-minted TalentRecord).
  // Idempotent: the (tenant_id, ref_type, ref_id) unique makes a re-run a no-op.
  // UUID-only, no cross-schema FK (I1).
  async attachRef(input: {
    subject_id: string;
    tenant_id: string;
    ref_type: ResolutionSubjectRefType;
    ref_id: string;
    link_source: string;
  }): Promise<void> {
    const existing = await this.prisma.resolutionSubjectRef.findUnique({
      where: {
        tenant_id_ref_type_ref_id: {
          tenant_id: input.tenant_id,
          ref_type: input.ref_type,
          ref_id: input.ref_id,
        },
      },
    });
    if (existing !== null) return;
    await this.prisma.resolutionSubjectRef.create({
      data: {
        id: uuidv7(),
        subject_id: input.subject_id,
        tenant_id: input.tenant_id,
        ref_type: input.ref_type,
        ref_id: input.ref_id,
        link_source: input.link_source,
      },
    });
  }

  // ---- Promotion Gate Slice-B1 — reconcile poll ---------------------------

  // Promoted subjects (carrying an ATS_TALENT_RECORD ref) whose immutable
  // EvidenceRecord history has grown SINCE the reconcile watermark (or that were
  // never reconciled). The "newer unreconciled evidence" gate is a row-relative
  // compare (e.created_at > s.last_reconciled_at) — beyond Prisma's typed API,
  // so raw SQL. Oldest subject first; bounded by reconcile_attempts.
  async findSubjectsNeedingReconcile(args: {
    limit: number;
    maxAttempts: number;
  }): Promise<ReconcileTargetRow[]> {
    const rows = await this.prisma.$queryRawUnsafe<
      Array<{ subject_id: string; tenant_id: string; talent_record_id: string }>
    >(
      `SELECT DISTINCT ON (s.id) s.id AS subject_id, s.tenant_id, r.ref_id AS talent_record_id
       FROM "talent_trust"."ResolutionSubject" s
       JOIN "talent_trust"."ResolutionSubjectRef" r
         ON r.subject_id = s.id AND r.ref_type = 'ATS_TALENT_RECORD'
       WHERE s.status = 'ACTIVE'
         AND s.reconcile_attempts < $1
         AND EXISTS (
           SELECT 1 FROM "talent_trust"."EvidenceRecord" e
           WHERE e.subject_id = s.id
             AND e.created_at > COALESCE(s.last_reconciled_at, '1970-01-01'::timestamptz)
         )
       ORDER BY s.id, s.created_at ASC
       LIMIT $2`,
      args.maxAttempts,
      args.limit,
    );
    return rows.map((r) => ({
      subject_id: r.subject_id,
      tenant_id: r.tenant_id,
      talent_record_id: r.talent_record_id,
    }));
  }

  // Stamp the reconcile watermark (LAST write — advances past the evidence just
  // projected). The next tick re-selects only if newer evidence arrives.
  async markReconciled(subjectId: string): Promise<void> {
    await this.prisma.resolutionSubject.update({
      where: { id: subjectId },
      data: { last_reconciled_at: new Date() },
    });
  }

  // Record a transient reconcile failure — bump the attempt counter, leave the
  // watermark un-advanced so the next tick re-picks (bounded by maxAttempts).
  async bumpReconcileAttempt(subjectId: string): Promise<void> {
    await this.prisma.resolutionSubject.update({
      where: { id: subjectId },
      data: { reconcile_attempts: { increment: 1 } },
    });
  }

  // ---- Promotion-Trigger slice B-api — sourcing-pool readers -----------------

  // The pre-promotion pool: ACTIVE ResolutionSubjects for a tenant that ARE a
  // sourced arrival (SOURCED_TALENT ref EXISTS) but are NOT yet promoted
  // (ATS_TALENT_RECORD ref does NOT exist) — the anti-join. Bands +
  // open_contradiction_count come from the 1:1 TrustState LEFT JOIN (NULL bands
  // when a subject has no evidence yet). Keyset-paginated oldest-first
  // (created_at, id) — a growing pool must not be offset-paginated. Raw SQL for
  // the anti-join + row-tuple keyset (beyond Prisma's typed API).
  async listSourcedPool(args: {
    tenant_id: string;
    limit: number;
    cursor?: { created_at: Date; id: string } | null;
  }): Promise<SourcedPoolRow[]> {
    const params: unknown[] = [args.tenant_id, args.limit];
    let cursorClause = '';
    if (args.cursor) {
      cursorClause = `AND (s.created_at, s.id) > ($3::timestamptz, $4::uuid)`;
      params.push(args.cursor.created_at, args.cursor.id);
    }
    const rows = await this.prisma.$queryRawUnsafe<
      Array<{
        subject_id: string;
        created_at: Date;
        identity_band: string | null;
        claims_band: string | null;
        continuity_band: string | null;
        eligibility_band: string | null;
        open_contradiction_count: number;
      }>
    >(
      `SELECT s.id AS subject_id, s.created_at,
              ts.identity_band, ts.claims_band, ts.continuity_band, ts.eligibility_band,
              COALESCE(ts.open_contradiction_count, 0)::int AS open_contradiction_count
       FROM "talent_trust"."ResolutionSubject" s
       LEFT JOIN "talent_trust"."TrustState" ts ON ts.subject_id = s.id
       WHERE s.tenant_id = $1 AND s.status = 'ACTIVE'
         AND EXISTS (SELECT 1 FROM "talent_trust"."ResolutionSubjectRef" r
                     WHERE r.subject_id = s.id AND r.ref_type = 'SOURCED_TALENT')
         AND NOT EXISTS (SELECT 1 FROM "talent_trust"."ResolutionSubjectRef" a
                         WHERE a.subject_id = s.id AND a.ref_type = 'ATS_TALENT_RECORD')
         ${cursorClause}
       ORDER BY s.created_at ASC, s.id ASC
       LIMIT $2`,
      ...params,
    );
    return rows.map((r) => ({
      subject_id: r.subject_id,
      created_at: r.created_at,
      identity_band: r.identity_band,
      claims_band: r.claims_band,
      continuity_band: r.continuity_band,
      eligibility_band: r.eligibility_band,
      open_contradiction_count: Number(r.open_contradiction_count),
    }));
  }

  // Batched display-identity evidence for a PAGE of subjects (NOT N+1). Newest-
  // first so the service takes the newest FULL_NAME / EMAIL per subject. Only
  // VALID evidence. @@index([tenant_id, subject_id]) serves the IN-list.
  async listDisplayIdentityEvidence(
    tenantId: string,
    subjectIds: string[],
  ): Promise<DisplayIdentityEvidenceRow[]> {
    if (subjectIds.length === 0) return [];
    const rows = await this.prisma.evidenceRecord.findMany({
      where: {
        tenant_id: tenantId,
        subject_id: { in: subjectIds },
        assertion_type: { in: ['FULL_NAME', 'EMAIL'] },
        current_status: 'VALID',
      },
      select: { subject_id: true, assertion_type: true, assertion_payload: true },
      orderBy: { collected_at: 'desc' },
    });
    return rows.map((r) => ({
      subject_id: r.subject_id,
      assertion_type: r.assertion_type,
      assertion_payload: r.assertion_payload,
    }));
  }

  async setSubjectMergeState(
    subjectId: string,
    status: ResolutionSubjectStatus,
    mergedIntoSubjectId: string | null,
  ): Promise<ResolutionSubjectRow> {
    const updated = await this.prisma.resolutionSubject.update({
      where: { id: subjectId },
      data: { status, merged_into_subject_id: mergedIntoSubjectId },
    });
    return updated as ResolutionSubjectRow;
  }

  // ---- EvidenceRecord -------------------------------------------------

  async insertEvidence(input: InsertEvidenceInput): Promise<EvidenceRecordRow> {
    const created = await this.prisma.evidenceRecord.create({
      data: {
        id: uuidv7(),
        subject_id: input.subject_id,
        tenant_id: input.tenant_id,
        dimension: input.dimension,
        assertion_type: input.assertion_type,
        assertion_payload: input.assertion_payload as never,
        source_class: input.source_class,
        source_ref: (input.source_ref ?? null) as never,
        method: input.method,
        strength: input.strength,
        collected_at: input.collected_at,
        decay_profile: input.decay_profile,
        portability_class: input.portability_class,
        ai_derived: input.ai_derived,
        current_status: input.current_status,
        created_by: input.created_by,
      },
    });
    return created as EvidenceRecordRow;
  }

  async findEvidenceById(id: string): Promise<EvidenceRecordRow | null> {
    const row = await this.prisma.evidenceRecord.findUnique({ where: { id } });
    return (row as EvidenceRecordRow | null) ?? null;
  }

  async listEvidenceBySubject(
    subjectId: string,
    filters?: { dimension?: TrustDimension; current_status?: EvidenceStatus },
  ): Promise<EvidenceRecordRow[]> {
    const rows = await this.prisma.evidenceRecord.findMany({
      where: {
        subject_id: subjectId,
        ...(filters?.dimension ? { dimension: filters.dimension } : {}),
        ...(filters?.current_status ? { current_status: filters.current_status } : {}),
      },
      orderBy: { created_at: 'asc' },
    });
    return rows as EvidenceRecordRow[];
  }

  // TR-2a-B3a (DDR-3 §5) — the cluster-union evidence read: every EvidenceRecord
  // across a set of cluster members, globally ordered by created_at (one query,
  // not N). Each row carries its ORIGIN subject_id + provenance UNTOUCHED —
  // evidence never moves; the union is a read-time projection. A single-element
  // set is byte-identical to listEvidenceBySubject (the unmerged common case).
  async listEvidenceBySubjects(
    subjectIds: string[],
    filters?: { dimension?: TrustDimension; current_status?: EvidenceStatus },
  ): Promise<EvidenceRecordRow[]> {
    if (subjectIds.length === 0) return [];
    const rows = await this.prisma.evidenceRecord.findMany({
      where: {
        subject_id: { in: subjectIds },
        ...(filters?.dimension ? { dimension: filters.dimension } : {}),
        ...(filters?.current_status ? { current_status: filters.current_status } : {}),
      },
      orderBy: { created_at: 'asc' },
    });
    return rows as EvidenceRecordRow[];
  }

  // The ONLY mutable column on EvidenceRecord (the immutability trigger
  // rejects any other change). Set exclusively by applying an EvidenceEvent.
  async updateEvidenceStatus(id: string, status: EvidenceStatus): Promise<EvidenceRecordRow> {
    const updated = await this.prisma.evidenceRecord.update({
      where: { id },
      data: { current_status: status },
    });
    return updated as EvidenceRecordRow;
  }

  // ---- EvidenceEvent (append-only) -----------------------------------

  async appendEvent(input: {
    evidence_id: string;
    tenant_id: string;
    event_type: EvidenceEventType;
    reason?: string | null;
    linked_evidence_id?: string | null;
    actor?: string | null;
    occurred_at?: Date;
  }): Promise<void> {
    await this.prisma.evidenceEvent.create({
      data: {
        id: uuidv7(),
        evidence_id: input.evidence_id,
        tenant_id: input.tenant_id,
        event_type: input.event_type,
        reason: input.reason ?? null,
        linked_evidence_id: input.linked_evidence_id ?? null,
        actor: input.actor ?? null,
        ...(input.occurred_at ? { occurred_at: input.occurred_at } : {}),
      },
    });
  }

  // ---- EvidenceLink (append-only) ------------------------------------

  async appendLink(input: {
    from_evidence_id: string;
    to_evidence_id: string;
    relation: EvidenceLinkRelation;
    tenant_id: string;
  }): Promise<void> {
    await this.prisma.evidenceLink.create({
      data: {
        id: uuidv7(),
        from_evidence_id: input.from_evidence_id,
        to_evidence_id: input.to_evidence_id,
        relation: input.relation,
        tenant_id: input.tenant_id,
      },
    });
  }

  // TR-4 B1 (DDR §2.4) — existence check backing the service-side no-op: is this
  // exact semantic link (from, to, relation) already recorded? Keyed on the new
  // @@unique triple. Returns true if a repeat raise should be skipped.
  async evidenceLinkExists(
    fromEvidenceId: string,
    toEvidenceId: string,
    relation: EvidenceLinkRelation,
  ): Promise<boolean> {
    const row = await this.prisma.evidenceLink.findFirst({
      where: {
        from_evidence_id: fromEvidenceId,
        to_evidence_id: toEvidenceId,
        relation,
      },
      select: { id: true },
    });
    return row !== null;
  }

  // TR-14 B1 (DDR §2.2) — the link-graph READ for the dossier: every link that
  // touches any evidence id in the set, in EITHER direction (from OR to), so the
  // dossier can assemble contradiction pairs and supersede chains around a
  // record's evidence. The caller passes the CLUSTER-UNION evidence ids, so the
  // read is cluster-union-safe by construction. Each direction rides its own
  // @@index([tenant_id, from|to_evidence_id]). Append-only order (created_at asc).
  async listEvidenceLinksForEvidence(evidenceIds: string[]): Promise<EvidenceLinkRow[]> {
    if (evidenceIds.length === 0) return [];
    const rows = await this.prisma.evidenceLink.findMany({
      where: {
        OR: [
          { from_evidence_id: { in: evidenceIds } },
          { to_evidence_id: { in: evidenceIds } },
        ],
      },
      orderBy: { created_at: 'asc' },
    });
    return rows as EvidenceLinkRow[];
  }

  // TR-14 B1 (DDR §2.2) — the event-timeline READ for the dossier: the lifecycle
  // events of every evidence row across a subject's CLUSTER-UNION, keyset-paged
  // NEWEST-FIRST (the ledger can be long). EvidenceEvent has no FK to
  // EvidenceRecord (UUID-only by design), so this resolves the cluster's evidence
  // ids first, then pages events over them. Keyset on (occurred_at, id) desc —
  // the same (timestamp, id) tuple convention as the sourcing/worklist cursors.
  async listEvidenceEventsBySubjects(
    subjectIds: string[],
    opts: { limit: number; before?: { occurred_at: Date; id: string } },
  ): Promise<EvidenceEventRow[]> {
    if (subjectIds.length === 0) return [];
    const evidence = await this.prisma.evidenceRecord.findMany({
      where: { subject_id: { in: subjectIds } },
      select: { id: true },
    });
    const evidenceIds = evidence.map((e) => e.id);
    if (evidenceIds.length === 0) return [];
    const rows = await this.prisma.evidenceEvent.findMany({
      where: {
        evidence_id: { in: evidenceIds },
        ...(opts.before
          ? {
              OR: [
                { occurred_at: { lt: opts.before.occurred_at } },
                { occurred_at: opts.before.occurred_at, id: { lt: opts.before.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ occurred_at: 'desc' }, { id: 'desc' }],
      take: opts.limit,
    });
    return rows as EvidenceEventRow[];
  }

  // TR-4 B2 (DDR §3.2) — the dual-write idempotence existence check: does an
  // EvidenceRecord already exist for this (subject, assertion_type) whose
  // source_ref points at the given talent_evidence row? Keyed on the STABLE typed
  // row id (source_ref.talent_evidence_id), so a re-run / backfill writes nothing
  // already written. JSONB path filter on the source_ref column.
  async claimEvidenceExistsBySourceRef(
    subjectId: string,
    assertionType: string,
    talentEvidenceId: string,
  ): Promise<boolean> {
    const row = await this.prisma.evidenceRecord.findFirst({
      where: {
        subject_id: subjectId,
        assertion_type: assertionType,
        source_ref: { path: ['talent_evidence_id'], equals: talentEvidenceId },
      },
      select: { id: true },
    });
    return row !== null;
  }

  // ---- TrustState (projection — recomputed on every write) -----------

  async upsertTrustState(input: TrustStateRow): Promise<TrustStateRow> {
    const upserted = await this.prisma.trustState.upsert({
      where: { subject_id: input.subject_id },
      create: { ...input },
      update: {
        identity_band: input.identity_band,
        claims_band: input.claims_band,
        continuity_band: input.continuity_band,
        eligibility_band: input.eligibility_band,
        open_contradiction_count: input.open_contradiction_count,
        stale_evidence_count: input.stale_evidence_count,
        has_open_dispute: input.has_open_dispute,
        single_source_only: input.single_source_only,
        longitudinal_observed: input.longitudinal_observed,
        last_recomputed_at: input.last_recomputed_at,
      },
    });
    return upserted as TrustStateRow;
  }

  async findTrustStateBySubject(subjectId: string): Promise<TrustStateRow | null> {
    const row = await this.prisma.trustState.findUnique({ where: { subject_id: subjectId } });
    return (row as TrustStateRow | null) ?? null;
  }

  // ---- SubjectAnchor (TR-2a-1 within-tenant match index) -------------------

  // Idempotency gate: the producer checks this before writing so a re-run /
  // backfill never duplicates the anchor OR its evidence.
  async findSubjectAnchor(
    tenantId: string,
    subjectId: string,
    anchorKind: AnchorKind,
    normalizedValue: string,
    // TR-2a-B1 (DDR-1 §3.2) — the idempotency key gained source_class: a value
    // anchored later at a higher class is a NEW append-only row, so exists-check
    // is per (tenant, subject, kind, value, class).
    sourceClass: SourceClass,
  ): Promise<SubjectAnchorRow | null> {
    const row = await this.prisma.subjectAnchor.findUnique({
      where: {
        tenant_id_subject_id_anchor_kind_normalized_value_source_class: {
          tenant_id: tenantId,
          subject_id: subjectId,
          anchor_kind: anchorKind,
          normalized_value: normalizedValue,
          source_class: sourceClass,
        },
      },
    });
    return (row as SubjectAnchorRow | null) ?? null;
  }

  async listAnchorsBySubject(subjectId: string): Promise<SubjectAnchorRow[]> {
    const rows = await this.prisma.subjectAnchor.findMany({
      where: { subject_id: subjectId },
      orderBy: { created_at: 'asc' },
    });
    return rows as SubjectAnchorRow[];
  }

  // TR-2a-2 — the matcher's btree read: subjects sharing a normalized value in-tenant.
  // Tenant-scoped (the cross-tenant path is TR-2b / identity_index, never this table).
  // Uses the @@index([tenant_id, anchor_kind, normalized_value]) surface.
  async findAnchorsByValue(
    tenantId: string,
    anchorKind: AnchorKind,
    normalizedValue: string,
  ): Promise<SubjectAnchorRow[]> {
    const rows = await this.prisma.subjectAnchor.findMany({
      where: { tenant_id: tenantId, anchor_kind: anchorKind, normalized_value: normalizedValue },
    });
    return rows as SubjectAnchorRow[];
  }

  // The distinct subjects in a tenant that carry ≥1 anchor — the backfill sweep's
  // work-list (matcher runs per subject; the canonical-pair unique key dedupes).
  async listSubjectIdsWithAnchors(tenantId: string): Promise<string[]> {
    const rows = await this.prisma.subjectAnchor.findMany({
      where: { tenant_id: tenantId },
      distinct: ['subject_id'],
      select: { subject_id: true },
      orderBy: { subject_id: 'asc' },
    });
    return rows.map((r) => r.subject_id);
  }

  // TR-6 B1 (DDR §2) — the scheduled sweep's incremental gate query. Returns
  // ACTIVE subjects (MERGED husks are excluded from the outer loop — they are
  // handled by D2 on the sharer side) that carry ≥1 anchor NEWER than their
  // last_matched_at watermark (NULL = never matched). Anchors are append-only, so
  // a new anchor since the last match is the complete invalidation condition.
  // DISTINCT ON the subject, oldest-newest-anchor first, LIMIT-bounded per tick.
  // Tenant-agnostic (the row carries tenant_id) so one query drains all tenants.
  async listSubjectsToMatch(
    limit: number,
  ): Promise<Array<{ subject_id: string; tenant_id: string }>> {
    const rows = await this.prisma.$queryRawUnsafe<
      Array<{ subject_id: string; tenant_id: string }>
    >(
      `SELECT DISTINCT ON (s.id) s.id AS subject_id, s.tenant_id AS tenant_id
         FROM "talent_trust"."ResolutionSubject" s
         JOIN "talent_trust"."SubjectAnchor" a ON a.subject_id = s.id
        WHERE s.status = 'ACTIVE'
          AND a.created_at > COALESCE(s.last_matched_at, TIMESTAMPTZ 'epoch')
        ORDER BY s.id
        LIMIT $1`,
      limit,
    );
    return rows;
  }

  // TR-6 B1 (DDR §2) — stamp the sweep watermark per subject on completion. The
  // LAST write of a per-subject sweep; a transient failure leaves it un-advanced
  // so the next tick re-selects the subject.
  async setLastMatchedAt(subjectId: string, at: Date): Promise<void> {
    await this.prisma.resolutionSubject.update({
      where: { id: subjectId },
      data: { last_matched_at: at },
    });
  }

  // TR-6 B1 (DDR §2) — the match-backfill CLI's --all-tenants escape hatch: every
  // tenant that owns ≥1 anchored subject (the full-resweep set).
  async listTenantIdsWithAnchors(): Promise<string[]> {
    const rows = await this.prisma.subjectAnchor.findMany({
      distinct: ['tenant_id'],
      select: { tenant_id: true },
      orderBy: { tenant_id: 'asc' },
    });
    return rows.map((r) => r.tenant_id);
  }

  // TR-4 B3 (§3.1) — the consistency-poll gate: the TR-6 match-sweep gate VERBATIM,
  // with the JOIN on CLAIMS-dimension evidence instead of anchors. ACTIVE subjects
  // with ≥1 CLAIMS EvidenceRecord created SINCE their consistency watermark (NULL =
  // never checked). DISTINCT ON, ordered, batch-limited; tenant-agnostic (drains all).
  async listSubjectsToCheckConsistency(
    limit: number,
    tenantId?: string,
  ): Promise<Array<{ subject_id: string; tenant_id: string }>> {
    // Optional tenant filter for the CLI escape hatch (the hourly poll passes none
    // and drains all tenants). $2 is null when unfiltered.
    const rows = await this.prisma.$queryRawUnsafe<
      Array<{ subject_id: string; tenant_id: string }>
    >(
      // TR-5 B2 (DDR §3.1) — the gate BROADENS from CLAIMS-only to ANY dimension.
      // The one poll now feeds both the TR-4 detectors (CLAIMS) and the TR-5
      // CONTINUITY derivers (which read IDENTITY contact + EMPLOYMENT evidence),
      // so a new IDENTITY arrival must re-select the subject too. One poll, one
      // watermark, detectors + derivers in a single per-subject pass.
      `SELECT DISTINCT ON (s.id) s.id AS subject_id, s.tenant_id AS tenant_id
         FROM "talent_trust"."ResolutionSubject" s
         JOIN "talent_trust"."EvidenceRecord" e ON e.subject_id = s.id
        WHERE s.status = 'ACTIVE'
          AND e.created_at > COALESCE(s.last_consistency_at, TIMESTAMPTZ 'epoch')
          AND ($2::uuid IS NULL OR s.tenant_id = $2::uuid)
        ORDER BY s.id
        LIMIT $1`,
      limit,
      tenantId ?? null,
    );
    return rows;
  }

  // TR-5 B1 (DDR §2) — the decay-recompute sweep gate. Selects ACTIVE subjects
  // whose TrustState was last recomputed before `staleBefore` (= now −
  // RECOMPUTE_STALENESS_DAYS) AND that carry ≥1 decaying evidence row — a
  // subject whose every row is DURABLE (the only non-decaying profile) cannot
  // drift, so it is skipped forever, cheaply. No watermark column: this is
  // time-driven on the existing TrustState.last_recomputed_at, which the
  // recompute itself advances, so a swept subject falls out of the gate
  // (idempotent by construction). The EXISTS leg correlates on
  // (tenant_id, subject_id) so it rides the existing composite index; the
  // decay_profile inequality is a cheap residual over a subject's few rows.
  // DISTINCT ON keeps the template shape (the TrustState join is 1:1, so no fan-out).
  async listSubjectsToRecompute(
    limit: number,
    staleBefore: Date,
    tenantId?: string,
  ): Promise<Array<{ subject_id: string; tenant_id: string }>> {
    const rows = await this.prisma.$queryRawUnsafe<
      Array<{ subject_id: string; tenant_id: string }>
    >(
      `SELECT DISTINCT ON (s.id) s.id AS subject_id, s.tenant_id AS tenant_id
         FROM "talent_trust"."ResolutionSubject" s
         JOIN "talent_trust"."TrustState" ts ON ts.subject_id = s.id
        WHERE s.status = 'ACTIVE'
          AND ts.last_recomputed_at < $2::timestamptz
          AND EXISTS (
            SELECT 1 FROM "talent_trust"."EvidenceRecord" e
             WHERE e.tenant_id = s.tenant_id
               AND e.subject_id = s.id
               AND e.decay_profile <> 'DURABLE'
          )
          AND ($3::uuid IS NULL OR s.tenant_id = $3::uuid)
        ORDER BY s.id
        LIMIT $1`,
      limit,
      staleBefore,
      tenantId ?? null,
    );
    return rows;
  }

  // TR-4 B3 — watermark writer, set LAST on a per-subject consistency run so a
  // transient failure leaves it un-advanced and the next tick re-selects the subject.
  async setLastConsistencyAt(subjectId: string, at: Date): Promise<void> {
    await this.prisma.resolutionSubject.update({
      where: { id: subjectId },
      data: { last_consistency_at: at },
    });
  }

  // TR-4 B3 (§3.2.3) — the TIMELINE_GAP idempotence check: is a gap already recorded
  // for this (subject, bounding-record pair)? Keyed on the composite source_ref, so
  // a re-run over unchanged evidence writes no duplicate gap.
  async timelineGapExists(
    subjectId: string,
    beforeEvidenceId: string,
    afterEvidenceId: string,
  ): Promise<boolean> {
    const row = await this.prisma.evidenceRecord.findFirst({
      where: {
        subject_id: subjectId,
        assertion_type: 'TIMELINE_GAP',
        AND: [
          { source_ref: { path: ['before_evidence_id'], equals: beforeEvidenceId } },
          { source_ref: { path: ['after_evidence_id'], equals: afterEvidenceId } },
        ],
      },
      select: { id: true },
    });
    return row !== null;
  }

  // The anchor write — EvidenceRecord (source of truth) + its CREATED event +
  // the SubjectAnchor projection, in ONE transaction (atomic: no projection
  // without its evidence, no evidence without its projection).
  async insertAnchor(
    input: InsertAnchorInput,
  ): Promise<{ evidence: EvidenceRecordRow; anchor: SubjectAnchorRow }> {
    const ev = input.evidence;
    const evidenceId = uuidv7();
    const anchorId = uuidv7();
    const [evidence, anchor] = await this.prisma.$transaction([
      this.prisma.evidenceRecord.create({
        data: {
          id: evidenceId,
          subject_id: ev.subject_id,
          tenant_id: ev.tenant_id,
          dimension: ev.dimension,
          assertion_type: ev.assertion_type,
          assertion_payload: ev.assertion_payload as never,
          source_class: ev.source_class,
          source_ref: (ev.source_ref ?? null) as never,
          method: ev.method,
          strength: ev.strength,
          collected_at: ev.collected_at,
          decay_profile: ev.decay_profile,
          portability_class: ev.portability_class,
          ai_derived: ev.ai_derived,
          current_status: ev.current_status,
          created_by: ev.created_by,
        },
      }),
      this.prisma.subjectAnchor.create({
        data: {
          id: anchorId,
          subject_id: ev.subject_id,
          tenant_id: ev.tenant_id,
          anchor_kind: input.anchor_kind,
          normalized_value: input.normalized_value,
          source_evidence_id: evidenceId,
          // TR-2a-B1 (DDR-1 §3.2) — the projection stays atomic with its
          // evidence: same source_class as the minting EvidenceRecord.
          source_class: ev.source_class,
        },
      }),
      this.prisma.evidenceEvent.create({
        data: {
          id: uuidv7(),
          evidence_id: evidenceId,
          tenant_id: ev.tenant_id,
          event_type: 'CREATED',
          actor: ev.created_by,
        },
      }),
    ]);
    return {
      evidence: evidence as EvidenceRecordRow,
      anchor: anchor as SubjectAnchorRow,
    };
  }

  // ---- VerificationRequest (TR-3 B2 — the T3-B1 table's writer) -----------

  // Create a fresh PENDING verification request. One row per mint; a resend
  // rotates the token IN PLACE on the open row (rotateVerificationToken) rather
  // than inserting a second row (§3.1 rotate-on-resend + idempotent-return).
  async createVerificationRequest(
    input: CreateVerificationRequestInput,
  ): Promise<VerificationRequestRow> {
    const row = await this.prisma.verificationRequest.create({
      data: {
        id: uuidv7(),
        tenant_id: input.tenant_id,
        talent_record_id: input.talent_record_id,
        subject_id: input.subject_id,
        anchor_kind: input.anchor_kind,
        normalized_value: input.normalized_value,
        token_hash: input.token_hash,
        // status defaults to 'PENDING'.
        created_by: input.created_by,
        expires_at: input.expires_at,
      },
    });
    return row as VerificationRequestRow;
  }

  // Idempotency read (§3.1) — the single OPEN, non-expired request for a
  // (tenant, subject, kind, value). A second request while one is live rotates
  // this row's token rather than minting a duplicate. Expired PENDING rows are
  // NOT open (they must mint fresh). At most one exists by construction (the
  // request path only ever creates when none is open).
  async findOpenVerificationRequest(
    tenantId: string,
    subjectId: string,
    anchorKind: AnchorKind,
    normalizedValue: string,
    now: Date,
  ): Promise<VerificationRequestRow | null> {
    const row = await this.prisma.verificationRequest.findFirst({
      where: {
        tenant_id: tenantId,
        subject_id: subjectId,
        anchor_kind: anchorKind,
        normalized_value: normalizedValue,
        status: 'PENDING',
        consumed_at: null,
        expires_at: { gt: now },
      },
      orderBy: { created_at: 'desc' },
    });
    return row === null ? null : (row as VerificationRequestRow);
  }

  // Resend (§3.1) — rotate the token secret + re-stamp the TTL on an existing
  // open request, IN PLACE. The prior raw token is thereby invalidated (its hash
  // no longer matches this row) — the "revoked" state the confirm path treats
  // as indistinguishable-not-found (§3.2, acceptance (e)).
  async rotateVerificationToken(
    id: string,
    tokenHash: string,
    expiresAt: Date,
  ): Promise<VerificationRequestRow> {
    const row = await this.prisma.verificationRequest.update({
      where: { id },
      data: { token_hash: tokenHash, expires_at: expiresAt },
    });
    return row as VerificationRequestRow;
  }

  // The atomic REPLAY LOCK (§3.2) — a single guarded UPDATE claims the request:
  // it flips PENDING→CONFIRMED + stamps consumed_at ONLY when the row is still
  // live (token matches, not consumed, PENDING, unexpired). Concurrent confirms
  // race on this UPDATE — exactly one flips a row (Postgres row lock); the loser
  // matches zero rows. Returns the claimed row, or null for EVERY invalid state
  // (bad/expired/consumed/rotated token) — the caller cannot tell which, and
  // neither can an attacker. The mint runs only for the single winner.
  async consumeVerificationRequest(
    tokenHash: string,
    now: Date,
  ): Promise<VerificationRequestRow | null> {
    const claimed = await this.prisma.verificationRequest.updateMany({
      where: {
        token_hash: tokenHash,
        consumed_at: null,
        status: 'PENDING',
        expires_at: { gt: now },
      },
      data: { status: 'CONFIRMED', consumed_at: now },
    });
    if (claimed.count === 0) return null;
    // token_hash is @unique — the row we just flipped is the one and only match.
    const row = await this.prisma.verificationRequest.findUnique({
      where: { token_hash: tokenHash },
    });
    return row === null ? null : (row as VerificationRequestRow);
  }

  // Status read (§3.3) — the most-recent request for a (tenant, subject, kind,
  // value), regardless of status. Backs the record-detail pending/expired
  // display (verified is read off the anchor, not this row).
  async findLatestVerificationRequest(
    tenantId: string,
    subjectId: string,
    anchorKind: AnchorKind,
    normalizedValue: string,
  ): Promise<VerificationRequestRow | null> {
    const row = await this.prisma.verificationRequest.findFirst({
      where: {
        tenant_id: tenantId,
        subject_id: subjectId,
        anchor_kind: anchorKind,
        normalized_value: normalizedValue,
      },
      orderBy: { created_at: 'desc' },
    });
    return row === null ? null : (row as VerificationRequestRow);
  }

  // ---- SubjectMatchAdvisory (TR-2a-2 within-tenant same-human advisory) ----

  // Upsert an advisory by its canonical unordered pair — STATUS-AWARE (DDR-2 §5,
  // TR-2a-B2). The old "always overwrite band/basis regardless of status" is
  // RETIRED (Q2.3 silent-drift bug):
  //   - no row            → create PENDING_REVIEW.
  //   - PENDING_REVIEW    → update band / has_contradiction / basis as today.
  //   - DISMISSED         → re-open to PENDING_REVIEW IFF strictly stronger
  //     (shared-ref count increased OR a new confirmed_kinds entry), recording
  //     reopen provenance; otherwise STRICT NO-OP (no silent field drift; new
  //     contradictions / corroborator conflicts do NOT re-open).
  //   - MERGED | REVERSED → never touched (their lifecycle is applyAdvisory…).
  // has_contradiction = anchor contradiction ∪ corroborator conflicts; the basis
  // merges resolver-contributed corroborator_conflict_kinds (PII-free labels).
  async upsertMatchAdvisory(
    input: UpsertMatchAdvisoryInput,
  ): Promise<SubjectMatchAdvisoryRow> {
    const corroborator = input.corroborator_conflict_kinds ?? [];
    const hasContradiction = input.has_contradiction || corroborator.length > 0;
    const storedBasis: MatchBasis = {
      shared: input.match_basis.shared,
      contradiction_kinds: input.match_basis.contradiction_kinds,
      confirmed_kinds: input.match_basis.confirmed_kinds,
      ...(corroborator.length > 0 ? { corroborator_conflict_kinds: corroborator } : {}),
    };

    const existing = await this.findMatchAdvisory(
      input.tenant_id,
      input.subject_a_id,
      input.subject_b_id,
    );

    if (existing === null) {
      const created = await this.prisma.subjectMatchAdvisory.create({
        data: {
          id: uuidv7(),
          tenant_id: input.tenant_id,
          subject_a_id: input.subject_a_id,
          subject_b_id: input.subject_b_id,
          advise_band: input.advise_band,
          has_contradiction: hasContradiction,
          match_basis: storedBasis as never,
          created_by: input.created_by,
          // status defaults to PENDING_REVIEW.
        },
      });
      return created as SubjectMatchAdvisoryRow;
    }

    if (existing.status === 'PENDING_REVIEW') {
      const updated = await this.prisma.subjectMatchAdvisory.update({
        where: { id: existing.id },
        data: {
          advise_band: input.advise_band,
          has_contradiction: hasContradiction,
          match_basis: storedBasis as never,
        },
      });
      return updated as SubjectMatchAdvisoryRow;
    }

    if (existing.status === 'DISMISSED') {
      const prev = (existing.match_basis ?? {}) as Partial<MatchBasis>;
      const prevSharedCount = prev.shared?.length ?? 0;
      const prevConfirmed = new Set<AnchorKind>(prev.confirmed_kinds ?? []);
      const newConfirmedEntry = storedBasis.confirmed_kinds.some(
        (k) => !prevConfirmed.has(k),
      );
      const strictlyStronger =
        storedBasis.shared.length > prevSharedCount || newConfirmedEntry;
      if (!strictlyStronger) {
        // Strict no-op — no field drift on a non-pending advisory.
        return existing;
      }
      const reopened = await this.prisma.subjectMatchAdvisory.update({
        where: { id: existing.id },
        data: {
          status: 'PENDING_REVIEW',
          advise_band: input.advise_band,
          has_contradiction: hasContradiction,
          match_basis: storedBasis as never,
          reopened_at: new Date(),
          reopened_from_band: existing.advise_band,
        },
      });
      return reopened as SubjectMatchAdvisoryRow;
    }

    // MERGED | REVERSED — never touched by upsert.
    return existing;
  }

  async findMatchAdvisory(
    tenantId: string,
    subjectAId: string,
    subjectBId: string,
  ): Promise<SubjectMatchAdvisoryRow | null> {
    const row = await this.prisma.subjectMatchAdvisory.findUnique({
      where: {
        tenant_id_subject_a_id_subject_b_id: {
          tenant_id: tenantId,
          subject_a_id: subjectAId,
          subject_b_id: subjectBId,
        },
      },
    });
    return (row as SubjectMatchAdvisoryRow | null) ?? null;
  }

  // List advisories for a tenant, optionally filtered by the subject it involves
  // and/or its status (the reviewer queue is status = PENDING_REVIEW).
  async listMatchAdvisories(
    tenantId: string,
    opts?: { subjectId?: string; status?: MatchAdvisoryStatus },
  ): Promise<SubjectMatchAdvisoryRow[]> {
    const rows = await this.prisma.subjectMatchAdvisory.findMany({
      where: {
        tenant_id: tenantId,
        ...(opts?.status ? { status: opts.status } : {}),
        ...(opts?.subjectId
          ? { OR: [{ subject_a_id: opts.subjectId }, { subject_b_id: opts.subjectId }] }
          : {}),
      },
      orderBy: { created_at: 'asc' },
    });
    return rows as SubjectMatchAdvisoryRow[];
  }

  // TR-6 B2 (DDR D5) — the reviewer worklist's keyset page. Stable ordering
  // (created_at ASC, id ASC — oldest-pending first, FIFO) so the keyset cursor is
  // deterministic even when created_at ties. The cursor is the last item's id; take
  // limit+1 to detect a next page. Tenant-scoped + status-filtered (default caller-
  // supplied). No values ever leave the ledger — match_basis is PII-free (kinds +
  // anchor-row ids only), and the caller projects kinds only onto the wire.
  async listMatchAdvisoriesKeyset(
    tenantId: string,
    opts: { status?: MatchAdvisoryStatus; cursor?: string; limit: number },
  ): Promise<{ rows: SubjectMatchAdvisoryRow[]; nextCursor: string | null }> {
    const rows = await this.prisma.subjectMatchAdvisory.findMany({
      where: {
        tenant_id: tenantId,
        ...(opts.status ? { status: opts.status } : {}),
      },
      orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
      take: opts.limit + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > opts.limit;
    const page = hasMore ? rows.slice(0, opts.limit) : rows;
    const nextCursor = hasMore ? (page[page.length - 1]!.id as string) : null;
    return { rows: page as SubjectMatchAdvisoryRow[], nextCursor };
  }

  // ---- SubjectMatchAdvisory resolution (TR-2a-3) --------------------------

  // Tenant-scoped fetch by id — the resolution service loads-then-guards.
  async findMatchAdvisoryById(
    tenantId: string,
    id: string,
  ): Promise<SubjectMatchAdvisoryRow | null> {
    const row = await this.prisma.subjectMatchAdvisory.findFirst({
      where: { id, tenant_id: tenantId },
    });
    return (row as SubjectMatchAdvisoryRow | null) ?? null;
  }

  // Record a MERGE or DISMISS resolution on a PENDING_REVIEW advisory (R4/R5).
  // The status/resolution_action come from the caller; guards live in the service.
  async applyAdvisoryResolution(input: {
    id: string;
    status: Extract<MatchAdvisoryStatus, 'MERGED' | 'DISMISSED'>;
    resolution_action: Extract<MatchResolutionAction, 'MERGE' | 'DISMISS'>;
    resolved_by: string;
    resolved_at: Date;
    resolution_justification: string | null;
    surviving_subject_id: string | null;
    merged_subject_id: string | null;
  }): Promise<SubjectMatchAdvisoryRow> {
    const updated = await this.prisma.subjectMatchAdvisory.update({
      where: { id: input.id },
      data: {
        status: input.status,
        resolution_action: input.resolution_action,
        resolved_by: input.resolved_by,
        resolved_at: input.resolved_at,
        resolution_justification: input.resolution_justification,
        surviving_subject_id: input.surviving_subject_id,
        merged_subject_id: input.merged_subject_id,
      },
    });
    return updated as SubjectMatchAdvisoryRow;
  }

  // Record a REVERSE on a MERGED advisory (R2/R5) — layers the reversal audit on
  // top; the original resolution_* fields are preserved (append-style history).
  async applyAdvisoryReversal(input: {
    id: string;
    reversed_by: string;
    reversed_at: Date;
    reversal_justification: string;
  }): Promise<SubjectMatchAdvisoryRow> {
    const updated = await this.prisma.subjectMatchAdvisory.update({
      where: { id: input.id },
      data: {
        status: 'REVERSED',
        resolution_action: 'REVERSE',
        reversed_by: input.reversed_by,
        reversed_at: input.reversed_at,
        reversal_justification: input.reversal_justification,
      },
    });
    return updated as SubjectMatchAdvisoryRow;
  }

  // ---- SubjectMergeOperation (TR-2a-B3b — DDR-3 §6) ------------------------

  private mapOperation(row: unknown): SubjectMergeOperationRow {
    const r = row as Record<string, unknown>;
    return {
      id: r['id'] as string,
      tenant_id: r['tenant_id'] as string,
      kind: (r['kind'] as MergeOperationKind | undefined) ?? 'RECONCILE',
      actor: (r['actor'] as string | null) ?? null,
      reason: (r['reason'] as string | null) ?? null,
      advisory_id: (r['advisory_id'] as string | null) ?? null,
      surviving_subject_id: r['surviving_subject_id'] as string,
      merged_subject_id: r['merged_subject_id'] as string,
      surviving_record_id: (r['surviving_record_id'] as string | null) ?? null,
      superseded_record_id: (r['superseded_record_id'] as string | null) ?? null,
      status: r['status'] as SubjectMergeOperationRow['status'],
      ref_actions: (r['ref_actions'] as RefActionRecord[]) ?? [],
      sweep_steps: (r['sweep_steps'] as SweepStepRecord[]) ?? [],
      collision_records: (r['collision_records'] as CollisionRecord[]) ?? [],
      started_at: r['started_at'] as Date,
      completed_at: (r['completed_at'] as Date | null) ?? null,
      reversed_at: (r['reversed_at'] as Date | null) ?? null,
      reversed_by: (r['reversed_by'] as string | null) ?? null,
      reversal_justification: (r['reversal_justification'] as string | null) ?? null,
      post_merge_accretions: r['post_merge_accretions'] ?? null,
    };
  }

  // Create the operation record (the checkpoint anchor). One per merge; the
  // orchestrator holds its id and checkpoints against it.
  //
  // TR-6 B1 (DDR §5) — kind/actor/reason are optional: the reconcile orchestrator
  // omits them (kind defaults to RECONCILE — "reconcile flow unchanged except it
  // stamps its kind"; actor/reason null), and a direct merge/unmerge passes them.
  // status/completed_at default to PENDING/null (a fresh reconcile checkpoint, or a
  // direct merge the orchestrator may still enrich); a standalone direct unmerge
  // passes a terminal status.
  async createMergeOperation(input: {
    tenant_id: string;
    advisory_id: string | null;
    surviving_subject_id: string;
    merged_subject_id: string;
    surviving_record_id: string | null;
    superseded_record_id: string | null;
    kind?: MergeOperationKind;
    actor?: string | null;
    reason?: string | null;
    status?: 'PENDING' | 'COMPLETED' | 'REVERSED';
    completed_at?: Date | null;
  }): Promise<SubjectMergeOperationRow> {
    const created = await this.prisma.subjectMergeOperation.create({
      data: {
        id: uuidv7(),
        tenant_id: input.tenant_id,
        kind: input.kind ?? 'RECONCILE',
        actor: input.actor ?? null,
        reason: input.reason ?? null,
        advisory_id: input.advisory_id,
        surviving_subject_id: input.surviving_subject_id,
        merged_subject_id: input.merged_subject_id,
        surviving_record_id: input.surviving_record_id,
        superseded_record_id: input.superseded_record_id,
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.completed_at !== undefined ? { completed_at: input.completed_at } : {}),
      },
    });
    return this.mapOperation(created);
  }

  async findMergeOperationById(
    tenantId: string,
    id: string,
  ): Promise<SubjectMergeOperationRow | null> {
    const row = await this.prisma.subjectMergeOperation.findFirst({
      where: { id, tenant_id: tenantId },
    });
    return row ? this.mapOperation(row) : null;
  }

  // Idempotency / resume: the most recent operation for a merge direction (so a
  // re-run of approve→reconcile finds the in-flight operation instead of forking).
  async findMergeOperationBySubjects(
    tenantId: string,
    survivingSubjectId: string,
    mergedSubjectId: string,
  ): Promise<SubjectMergeOperationRow | null> {
    const row = await this.prisma.subjectMergeOperation.findFirst({
      where: {
        tenant_id: tenantId,
        surviving_subject_id: survivingSubjectId,
        merged_subject_id: mergedSubjectId,
      },
      orderBy: { started_at: 'desc' },
    });
    return row ? this.mapOperation(row) : null;
  }

  // The resume command's work-list: PENDING operations in a tenant (oldest first).
  async findPendingMergeOperations(tenantId: string): Promise<SubjectMergeOperationRow[]> {
    const rows = await this.prisma.subjectMergeOperation.findMany({
      where: { tenant_id: tenantId, status: 'PENDING' },
      orderBy: { started_at: 'asc' },
    });
    return rows.map((r) => this.mapOperation(r));
  }

  // TR-14 B1 (DDR §2.2) — the merge-history READ for the dossier's provenance
  // line: the COMPLETED operations this subject took part in, in EITHER role
  // (survivor or merged), oldest-first. Extends the existing partials
  // (tenant-PENDING / single-pair) with a per-subject completed view.
  async listCompletedMergeOperationsForSubject(
    tenantId: string,
    subjectId: string,
  ): Promise<SubjectMergeOperationRow[]> {
    const rows = await this.prisma.subjectMergeOperation.findMany({
      where: {
        tenant_id: tenantId,
        status: 'COMPLETED',
        OR: [{ surviving_subject_id: subjectId }, { merged_subject_id: subjectId }],
      },
      orderBy: { completed_at: 'asc' },
    });
    return rows.map((r) => this.mapOperation(r));
  }

  // Checkpoint: overwrite the progress arrays / record ids with the orchestrator's
  // current view (the orchestrator builds the full arrays and persists them each
  // step; small volumes). Idempotent — a resume re-persists the same shape.
  async updateMergeOperation(
    id: string,
    patch: {
      surviving_record_id?: string | null;
      superseded_record_id?: string | null;
      ref_actions?: RefActionRecord[];
      sweep_steps?: SweepStepRecord[];
      collision_records?: CollisionRecord[];
    },
  ): Promise<SubjectMergeOperationRow> {
    const updated = await this.prisma.subjectMergeOperation.update({
      where: { id },
      data: {
        ...(patch.surviving_record_id !== undefined
          ? { surviving_record_id: patch.surviving_record_id }
          : {}),
        ...(patch.superseded_record_id !== undefined
          ? { superseded_record_id: patch.superseded_record_id }
          : {}),
        ...(patch.ref_actions !== undefined ? { ref_actions: patch.ref_actions as never } : {}),
        ...(patch.sweep_steps !== undefined ? { sweep_steps: patch.sweep_steps as never } : {}),
        ...(patch.collision_records !== undefined
          ? { collision_records: patch.collision_records as never }
          : {}),
      },
    });
    return this.mapOperation(updated);
  }

  async completeMergeOperation(id: string, completedAt: Date): Promise<SubjectMergeOperationRow> {
    const updated = await this.prisma.subjectMergeOperation.update({
      where: { id },
      data: { status: 'COMPLETED', completed_at: completedAt },
    });
    return this.mapOperation(updated);
  }

  async markMergeOperationReversed(
    id: string,
    input: { reversed_by: string; reversed_at: Date; reversal_justification: string; post_merge_accretions: unknown },
  ): Promise<SubjectMergeOperationRow> {
    const updated = await this.prisma.subjectMergeOperation.update({
      where: { id },
      data: {
        status: 'REVERSED',
        reversed_by: input.reversed_by,
        reversed_at: input.reversed_at,
        reversal_justification: input.reversal_justification,
        post_merge_accretions: input.post_merge_accretions as never,
      },
    });
    return this.mapOperation(updated);
  }

  // TR-2a-B3b (DDR-3 §6 detection sweep) — pre-existing two-live-records clusters:
  // MERGED subjects whose surviving subject is ACTIVE and where BOTH subjects carry
  // an ATS_TALENT_RECORD ref (i.e. both were promoted before the reconcile writer
  // existed → two live records for one human, the state Q2.1 says is silently
  // creatable today). Returns the pair + both record ids; the orchestrator confirms
  // both records are still LIVE before reporting. Read-only — acts on nothing.
  async findMergedPromotedPairs(
    tenantId: string,
  ): Promise<
    Array<{
      merged_subject_id: string;
      surviving_subject_id: string;
      merged_record_id: string;
      surviving_record_id: string;
    }>
  > {
    const rows = await this.prisma.$queryRawUnsafe<
      Array<{
        merged_subject_id: string;
        surviving_subject_id: string;
        merged_record_id: string;
        surviving_record_id: string;
      }>
    >(
      `SELECT m.id AS merged_subject_id, s.id AS surviving_subject_id,
              rm.ref_id AS merged_record_id, rs.ref_id AS surviving_record_id
         FROM "talent_trust"."ResolutionSubject" m
         JOIN "talent_trust"."ResolutionSubject" s ON s.id = m.merged_into_subject_id AND s.status = 'ACTIVE'
         JOIN "talent_trust"."ResolutionSubjectRef" rm
           ON rm.subject_id = m.id AND rm.ref_type = 'ATS_TALENT_RECORD' AND rm.tenant_id = $1::uuid
         JOIN "talent_trust"."ResolutionSubjectRef" rs
           ON rs.subject_id = s.id AND rs.ref_type = 'ATS_TALENT_RECORD' AND rs.tenant_id = $1::uuid
        WHERE m.status = 'MERGED' AND m.tenant_id = $1::uuid`,
      tenantId,
    );
    return rows;
  }

  // ---- TR-6 B1 (DDR §7) — recurring integrity detection (READ-ONLY) --------
  // Four cheap detector classes the daily cron reports (Q4). Each is a pure read;
  // the cron logs counts and per-row context and MUTATES NOTHING. Tenant-agnostic
  // (each row carries tenant_id) so one query serves the all-tenants cron.

  // Class 1 — two-live-record clusters, ALL tenants (the global analogue of
  // findMergedPromotedPairs). The service confirms both records are still LIVE.
  async findAllMergedPromotedPairs(): Promise<
    Array<{
      tenant_id: string;
      merged_subject_id: string;
      surviving_subject_id: string;
      merged_record_id: string;
      surviving_record_id: string;
    }>
  > {
    return this.prisma.$queryRawUnsafe(
      `SELECT m.tenant_id AS tenant_id, m.id AS merged_subject_id, s.id AS surviving_subject_id,
              rm.ref_id AS merged_record_id, rs.ref_id AS surviving_record_id
         FROM "talent_trust"."ResolutionSubject" m
         JOIN "talent_trust"."ResolutionSubject" s ON s.id = m.merged_into_subject_id AND s.status = 'ACTIVE'
         JOIN "talent_trust"."ResolutionSubjectRef" rm
           ON rm.subject_id = m.id AND rm.ref_type = 'ATS_TALENT_RECORD' AND rm.tenant_id = m.tenant_id
         JOIN "talent_trust"."ResolutionSubjectRef" rs
           ON rs.subject_id = s.id AND rs.ref_type = 'ATS_TALENT_RECORD' AND rs.tenant_id = m.tenant_id
        WHERE m.status = 'MERGED'`,
    );
  }

  // Class 2 — crash-orphaned reconciles: SubjectMergeOperation PENDING beyond age
  // (the resume command is the human's tool). RECONCILE + DIRECT_MERGE alike — a
  // DIRECT_MERGE the orchestrator never enriched is equally orphaned.
  async findStalePendingOperations(
    olderThan: Date,
  ): Promise<Array<{ id: string; tenant_id: string; kind: MergeOperationKind; started_at: Date }>> {
    const rows = await this.prisma.subjectMergeOperation.findMany({
      where: { status: 'PENDING', started_at: { lt: olderThan } },
      select: { id: true, tenant_id: true, kind: true, started_at: true },
    });
    return rows as Array<{
      id: string;
      tenant_id: string;
      kind: MergeOperationKind;
      started_at: Date;
    }>;
  }

  // Class 3 — PENDING_REVIEW advisories beyond age (a reviewer backlog signal).
  async findStalePendingAdvisories(
    olderThan: Date,
  ): Promise<Array<{ id: string; tenant_id: string; created_at: Date }>> {
    const rows = await this.prisma.subjectMatchAdvisory.findMany({
      where: { status: 'PENDING_REVIEW', created_at: { lt: olderThan } },
      select: { id: true, tenant_id: true, created_at: true },
    });
    return rows;
  }

  // Class 4 — MERGED subjects still receiving writes: a husk with a SubjectAnchor
  // or EvidenceRecord created AFTER it was merged (the merge moment ≈ the latest
  // operation's started_at for that subject). A stale ref writing to the old
  // subject — surfaces on the survivor via cluster-union (B3a) but the husk-side
  // write is the anomaly.
  async findMergedSubjectsWithPostMergeWrites(): Promise<
    Array<{ subject_id: string; tenant_id: string }>
  > {
    return this.prisma.$queryRawUnsafe(
      `SELECT m.id AS subject_id, m.tenant_id AS tenant_id
         FROM "talent_trust"."ResolutionSubject" m
         JOIN LATERAL (
           SELECT max(o.started_at) AS merged_at
             FROM "talent_trust"."SubjectMergeOperation" o
            WHERE o.merged_subject_id = m.id
         ) mo ON true
        WHERE m.status = 'MERGED'
          AND mo.merged_at IS NOT NULL
          AND (
            EXISTS (SELECT 1 FROM "talent_trust"."SubjectAnchor" a
                     WHERE a.subject_id = m.id AND a.created_at > mo.merged_at)
            OR EXISTS (SELECT 1 FROM "talent_trust"."EvidenceRecord" e
                        WHERE e.subject_id = m.id AND e.created_at > mo.merged_at)
          )`,
    );
  }

  // ---- Ref normalization (TR-2a-B3b — DDR-3 §2, the #1 surface) ------------

  // Find a subject's ATS_TALENT_RECORD ref (the record linkage), or null. The
  // per-subject partial-unique guarantees ≤1, so findFirst is exact.
  async findAtsRecordRef(
    tenantId: string,
    subjectId: string,
  ): Promise<{ ref_id: string; linked_at: Date; link_source: string } | null> {
    const row = await this.prisma.resolutionSubjectRef.findFirst({
      where: { tenant_id: tenantId, subject_id: subjectId, ref_type: 'ATS_TALENT_RECORD' },
      select: { ref_id: true, linked_at: true, link_source: true },
    });
    return row ?? null;
  }

  // Re-home a ref to the surviving subject (one-promoted case). The per-subject
  // partial-unique permits it (the survivor has no ATS ref). Returns the recorded
  // action (verbatim linkage) for the operation record.
  async rehomeAtsRecordRef(
    tenantId: string,
    refId: string,
    fromSubjectId: string,
    toSubjectId: string,
  ): Promise<RefActionRecord> {
    const existing = await this.prisma.resolutionSubjectRef.findUnique({
      where: {
        tenant_id_ref_type_ref_id: { tenant_id: tenantId, ref_type: 'ATS_TALENT_RECORD', ref_id: refId },
      },
    });
    await this.prisma.resolutionSubjectRef.update({
      where: {
        tenant_id_ref_type_ref_id: { tenant_id: tenantId, ref_type: 'ATS_TALENT_RECORD', ref_id: refId },
      },
      data: { subject_id: toSubjectId },
    });
    return {
      kind: 're_homed',
      ref_type: 'ATS_TALENT_RECORD',
      ref_id: refId,
      from_subject_id: fromSubjectId,
      to_subject_id: toSubjectId,
      linked_at: (existing?.linked_at ?? new Date()).toISOString(),
      link_source: existing?.link_source ?? '',
    };
  }

  // Remove a ref row (both-promoted case) — linkage copied verbatim into the
  // returned action FIRST, so reversal re-creates it. Idempotent: a re-run after
  // removal finds nothing and returns null.
  async removeAtsRecordRef(
    tenantId: string,
    refId: string,
    fromSubjectId: string,
  ): Promise<RefActionRecord | null> {
    const existing = await this.prisma.resolutionSubjectRef.findUnique({
      where: {
        tenant_id_ref_type_ref_id: { tenant_id: tenantId, ref_type: 'ATS_TALENT_RECORD', ref_id: refId },
      },
    });
    if (existing === null) return null;
    await this.prisma.resolutionSubjectRef.delete({
      where: {
        tenant_id_ref_type_ref_id: { tenant_id: tenantId, ref_type: 'ATS_TALENT_RECORD', ref_id: refId },
      },
    });
    return {
      kind: 'removed',
      ref_type: 'ATS_TALENT_RECORD',
      ref_id: refId,
      from_subject_id: fromSubjectId,
      to_subject_id: null,
      linked_at: existing.linked_at.toISOString(),
      link_source: existing.link_source,
    };
  }

  // Reversal: re-create a removed ref verbatim (idempotent — the unique key makes a
  // re-run a no-op) OR re-home a re_homed ref back to its origin.
  async restoreRefAction(tenantId: string, action: RefActionRecord): Promise<void> {
    if (action.kind === 're_homed' && action.to_subject_id !== null) {
      await this.prisma.resolutionSubjectRef.update({
        where: {
          tenant_id_ref_type_ref_id: { tenant_id: tenantId, ref_type: action.ref_type, ref_id: action.ref_id },
        },
        data: { subject_id: action.from_subject_id },
      });
      return;
    }
    // removed → re-create verbatim.
    const existing = await this.prisma.resolutionSubjectRef.findUnique({
      where: {
        tenant_id_ref_type_ref_id: { tenant_id: tenantId, ref_type: action.ref_type, ref_id: action.ref_id },
      },
    });
    if (existing !== null) return;
    await this.prisma.resolutionSubjectRef.create({
      data: {
        id: uuidv7(),
        subject_id: action.from_subject_id,
        tenant_id: tenantId,
        ref_type: action.ref_type,
        ref_id: action.ref_id,
        link_source: action.link_source,
        linked_at: new Date(action.linked_at),
      },
    });
  }
}
