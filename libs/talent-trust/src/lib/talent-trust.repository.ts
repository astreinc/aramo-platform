import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';

import { PrismaService } from './prisma/prisma.service.js';
import type {
  AnchorKind,
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
}

// The upsert input for an advisory. Keyed by the canonical unordered pair.
export interface UpsertMatchAdvisoryInput {
  tenant_id: string;
  subject_a_id: string;
  subject_b_id: string;
  advise_band: MatchAdviseBand;
  has_contradiction: boolean;
  match_basis: unknown;
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
  ): Promise<SubjectAnchorRow | null> {
    const row = await this.prisma.subjectAnchor.findUnique({
      where: {
        tenant_id_subject_id_anchor_kind_normalized_value: {
          tenant_id: tenantId,
          subject_id: subjectId,
          anchor_kind: anchorKind,
          normalized_value: normalizedValue,
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

  // Upsert an advisory by its canonical unordered pair (idempotent backfill /
  // re-run). The derived fields (band / contradiction / basis) are recomputed and
  // updated; `status` is set ONLY on insert — this slice never mutates a status,
  // and a later slice's human resolution must not be clobbered by a re-sweep.
  async upsertMatchAdvisory(
    input: UpsertMatchAdvisoryInput,
  ): Promise<SubjectMatchAdvisoryRow> {
    const upserted = await this.prisma.subjectMatchAdvisory.upsert({
      where: {
        tenant_id_subject_a_id_subject_b_id: {
          tenant_id: input.tenant_id,
          subject_a_id: input.subject_a_id,
          subject_b_id: input.subject_b_id,
        },
      },
      create: {
        id: uuidv7(),
        tenant_id: input.tenant_id,
        subject_a_id: input.subject_a_id,
        subject_b_id: input.subject_b_id,
        advise_band: input.advise_band,
        has_contradiction: input.has_contradiction,
        match_basis: input.match_basis as never,
        created_by: input.created_by,
        // status defaults to PENDING_REVIEW.
      },
      update: {
        advise_band: input.advise_band,
        has_contradiction: input.has_contradiction,
        match_basis: input.match_basis as never,
        // status intentionally NOT updated (append-only-style; preserve resolution).
      },
    });
    return upserted as SubjectMatchAdvisoryRow;
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
