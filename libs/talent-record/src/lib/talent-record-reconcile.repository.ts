import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';

import { PrismaService } from './prisma/prisma.service.js';

// Promotion Gate Slice-B1 — the talent_record-side reconcile writes: the
// fill-null/append enrichment of the flat TalentRecord row, plus the two
// projection-annotation tables (field→evidence provenance + pending
// contradictions). All same-schema (talent_record); evidence ids are cross-schema
// UUID-only refs to talent_trust.EvidenceRecord (no FK, §7.3 / I1). Enrich-only:
// this repo NEVER writes an identity-stable / talent-stated / recruiter-owned
// field (the caller passes only fill-null contact + key_skills), and NEVER acts
// on a contradiction (records the pending contradiction for B2).

// The enrichable columns (recon §1 / directive §3.4): fill-null contact +
// append key_skills only. Identity-stable (first/last_name), talent-stated
// (availability_status / engagement_type / work_authorization), recruiter-owned
// (notes / is_hot / …) and provenance (source / …) are DELIBERATELY absent.
export interface EnrichmentPatch {
  email1?: string;
  email2?: string;
  phone_home?: string;
  phone_cell?: string;
  phone_work?: string;
  address?: string;
  address2?: string;
  city?: string;
  state?: string;
  zip?: string;
  web_site?: string;
  current_employer?: string;
  key_skills?: string;
  // TALENT-INTEL-1 TI-1C — declared work-authorization status, fill-null +
  // contradiction from an EXPLICIT RIGHT_TO_WORK assertion (never a silent
  // overwrite of a talent-stated value). Explicit evidence only, no inference.
  work_authorization?: string;
}

export interface FieldProvenanceRow {
  field_name: string;
  evidence_id: string;
}

export interface PendingContradictionRow {
  field_name: string;
  new_evidence_id: string;
  status: string;
}

// TALENT-INTEL-1 TI-1D-A — TalentProfileFieldState closed vocabularies, enforced
// by the writer (TS union), not a DB CHECK (talent_record String-vocab precedent).
export type TalentProfileValueState = 'UNKNOWN' | 'SET' | 'EXPLICITLY_CLEARED';
export type TalentProfileSourceType = 'MANUAL' | 'RESUME' | 'RECONCILED' | 'IMPORT';
export type TalentProfileProjectionPolicy = 'AUTO' | 'HOLD';

export interface TalentProfileFieldStateRow {
  field_key: string;
  value_state: TalentProfileValueState;
  source_type: TalentProfileSourceType;
  projection_policy: TalentProfileProjectionPolicy;
}

// Slice-B2 — a pending contradiction joined to the incumbent EvidenceRecord the
// field currently projects (talent_record_field_provenance). incumbent_evidence_id
// is null ONLY if the create/null-fill provenance invariant was violated (B2
// leaves such a row pending + logs — never guesses an incumbent).
export interface PendingContradictionForResolution {
  id: string;
  tenant_id: string;
  talent_record_id: string;
  field_name: string;
  new_evidence_id: string;
  incumbent_evidence_id: string | null;
}

@Injectable()
export class TalentRecordReconcileRepository {
  constructor(private readonly prisma: PrismaService) {}

  // Apply the fill-null / append patch to the flat TalentRecord. Only the
  // provided keys are written (the caller includes a key ONLY when the slot was
  // null / being appended). Empty patch → no write. Keeps `current` a cheap
  // single row (no version fold).
  async applyEnrichment(args: {
    tenant_id: string;
    talent_record_id: string;
    patch: EnrichmentPatch;
  }): Promise<void> {
    const data = pruneUndefined(args.patch);
    if (Object.keys(data).length === 0) return;
    await this.prisma.talentRecord.update({
      where: { id: args.talent_record_id },
      data,
    });
  }

  // Upsert the field→evidence provenance (one per record+field). Idempotent —
  // a re-projection of the same field points it at the latest evidence.
  async upsertFieldProvenance(args: {
    tenant_id: string;
    talent_record_id: string;
    field_name: string;
    evidence_id: string;
  }): Promise<void> {
    await this.prisma.talentRecordFieldProvenance.upsert({
      where: {
        talent_record_id_field_name: {
          talent_record_id: args.talent_record_id,
          field_name: args.field_name,
        },
      },
      create: {
        id: uuidv7(),
        tenant_id: args.tenant_id,
        talent_record_id: args.talent_record_id,
        field_name: args.field_name,
        evidence_id: args.evidence_id,
      },
      update: { evidence_id: args.evidence_id, updated_at: new Date() },
    });
  }

  // Record a pending contradiction (B1 records, B2 acts). Idempotent
  // on (record, field, evidence) — re-runs never duplicate.
  async recordPendingContradiction(args: {
    tenant_id: string;
    talent_record_id: string;
    field_name: string;
    new_evidence_id: string;
  }): Promise<void> {
    const existing = await this.prisma.talentRecordReconcileContradiction.findUnique({
      where: {
        talent_record_id_field_name_new_evidence_id: {
          talent_record_id: args.talent_record_id,
          field_name: args.field_name,
          new_evidence_id: args.new_evidence_id,
        },
      },
    });
    if (existing !== null) return;
    await this.prisma.talentRecordReconcileContradiction.create({
      data: {
        id: uuidv7(),
        tenant_id: args.tenant_id,
        talent_record_id: args.talent_record_id,
        field_name: args.field_name,
        new_evidence_id: args.new_evidence_id,
        status: 'pending',
      },
    });
  }

  // Slice-B2 poll — pending contradictions joined to the incumbent EvidenceRecord
  // each field currently projects (talent_record_field_provenance). Oldest first;
  // LEFT JOIN so a (should-not-happen) missing-incumbent row still surfaces with
  // incumbent_evidence_id = null (B2 leaves it pending + logs). The status='pending'
  // filter is served by the @@index([tenant_id, status]).
  async findPendingContradictions(args: {
    limit: number;
  }): Promise<PendingContradictionForResolution[]> {
    const rows = await this.prisma.$queryRawUnsafe<
      Array<{
        id: string;
        tenant_id: string;
        talent_record_id: string;
        field_name: string;
        new_evidence_id: string;
        incumbent_evidence_id: string | null;
      }>
    >(
      `SELECT c.id, c.tenant_id, c.talent_record_id, c.field_name, c.new_evidence_id,
              p.evidence_id AS incumbent_evidence_id
       FROM "talent_record"."talent_record_reconcile_contradiction" c
       LEFT JOIN "talent_record"."talent_record_field_provenance" p
         ON p.talent_record_id = c.talent_record_id AND p.field_name = c.field_name
       WHERE c.status = 'pending'
       ORDER BY c.created_at ASC
       LIMIT $1`,
      args.limit,
    );
    return rows.map((r) => ({
      id: r.id,
      tenant_id: r.tenant_id,
      talent_record_id: r.talent_record_id,
      field_name: r.field_name,
      new_evidence_id: r.new_evidence_id,
      incumbent_evidence_id: r.incumbent_evidence_id,
    }));
  }

  // Slice-B2 done-marker — flip a pending contradiction to resolved AFTER
  // contradict() fires. This is the idempotency gate (contradict() is NOT
  // link-idempotent): a resolved row is never re-polled → no duplicate links.
  async markContradictionResolved(id: string): Promise<void> {
    await this.prisma.talentRecordReconcileContradiction.update({
      where: { id },
      data: { status: 'resolved' },
    });
  }

  async listFieldProvenance(talentRecordId: string): Promise<FieldProvenanceRow[]> {
    const rows = await this.prisma.talentRecordFieldProvenance.findMany({
      where: { talent_record_id: talentRecordId },
      select: { field_name: true, evidence_id: true },
      orderBy: { field_name: 'asc' },
    });
    return rows.map((r) => ({ field_name: r.field_name, evidence_id: r.evidence_id }));
  }

  async listPendingContradictions(
    talentRecordId: string,
  ): Promise<PendingContradictionRow[]> {
    const rows = await this.prisma.talentRecordReconcileContradiction.findMany({
      where: { talent_record_id: talentRecordId },
      select: { field_name: true, new_evidence_id: true, status: true },
      orderBy: { field_name: 'asc' },
    });
    return rows.map((r) => ({
      field_name: r.field_name,
      new_evidence_id: r.new_evidence_id,
      status: r.status,
    }));
  }

  // TALENT-INTEL-1 TI-1D-A — the reconcile service loads a talent's per-field
  // control states and passes them to computeReconcilePlan so an intentional
  // recruiter state (EXPLICITLY_CLEARED / HOLD) is never auto-projected over.
  async listProfileFieldStates(
    talentRecordId: string,
  ): Promise<TalentProfileFieldStateRow[]> {
    const rows = await this.prisma.talentProfileFieldState.findMany({
      where: { talent_record_id: talentRecordId },
      select: {
        field_key: true,
        value_state: true,
        source_type: true,
        projection_policy: true,
      },
      orderBy: { field_key: 'asc' },
    });
    return rows.map((r) => ({
      field_key: r.field_key,
      value_state: r.value_state as TalentProfileValueState,
      source_type: r.source_type as TalentProfileSourceType,
      projection_policy: r.projection_policy as TalentProfileProjectionPolicy,
    }));
  }

  // Upsert a field's control state (one row per tenant+record+field). The edit
  // endpoint calls this on an explicit clear/hold; value_state + projection_policy
  // capture "what the field is" and "whether automation may project" independently.
  async upsertProfileFieldState(args: {
    tenant_id: string;
    talent_record_id: string;
    field_key: string;
    value_state: TalentProfileValueState;
    source_type: TalentProfileSourceType;
    projection_policy: TalentProfileProjectionPolicy;
  }): Promise<void> {
    await this.prisma.talentProfileFieldState.upsert({
      where: {
        tenant_id_talent_record_id_field_key: {
          tenant_id: args.tenant_id,
          talent_record_id: args.talent_record_id,
          field_key: args.field_key,
        },
      },
      create: {
        tenant_id: args.tenant_id,
        talent_record_id: args.talent_record_id,
        field_key: args.field_key,
        value_state: args.value_state,
        source_type: args.source_type,
        projection_policy: args.projection_policy,
      },
      update: {
        value_state: args.value_state,
        source_type: args.source_type,
        projection_policy: args.projection_policy,
      },
    });
  }

  // Set a field's projection_policy (AUTO | HOLD) — the field_controls mutation
  // carried on the PATCH update body. It ONLY changes projection_policy; it NEVER
  // mutates value_state (PO ruling §3 — "what the field is" stays separate from
  // "whether automation may project") and never repopulates/clears the field
  // itself. updateMany over EXISTING rows only (no create): releasing a hold on a
  // field with no control state is a no-op.
  async setProjectionPolicy(args: {
    tenant_id: string;
    talent_record_id: string;
    field_key: string;
    projection_policy: TalentProfileProjectionPolicy;
  }): Promise<void> {
    await this.prisma.talentProfileFieldState.updateMany({
      where: {
        tenant_id: args.tenant_id,
        talent_record_id: args.talent_record_id,
        field_key: args.field_key,
      },
      data: { projection_policy: args.projection_policy },
    });
  }
}

function pruneUndefined(patch: EnrichmentPatch): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}
