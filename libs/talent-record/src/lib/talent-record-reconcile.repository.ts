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
}

function pruneUndefined(patch: EnrichmentPatch): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}
