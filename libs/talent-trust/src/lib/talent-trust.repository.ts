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

  // Resolve-or-create the ResolutionSubject for a ref (recordEvidence §8). One ref
  // → one subject within a tenant (the unique constraint). Returns the
  // subject id.
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
}
