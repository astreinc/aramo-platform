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

// TALENT-INTEL-1 TI-1D-B — the field-resolution SUMMARY vocabularies (current
// state, not history). Writer-enforced (no DB CHECK).
export type TalentProfileResolutionStatus = 'NONE' | 'PENDING_REVIEW' | 'RESOLVED';
export type TalentProfileResolutionReason =
  | 'EVIDENCE_CONFLICT'
  | 'ACCEPTED_PROPOSED'
  | 'KEPT_CURRENT'
  | 'MANUAL_CONFIRMATION';

export interface TalentProfileFieldStateRow {
  field_key: string;
  value_state: TalentProfileValueState;
  source_type: TalentProfileSourceType;
  projection_policy: TalentProfileProjectionPolicy;
}

// TALENT-INTEL-1 TI-1D-B — the field-state READ MODEL row: the per-field control
// state + resolution summary, joined to the field→evidence provenance
// (TalentRecordFieldProvenance stays the SOLE evidence-linkage authority — no
// source_evidence_id duplication). current_value is NOT here: the controller reads
// it from the canonical getById TalentRecord projection and merges it in, so this
// repo stays free of TalentRecord column coupling. No raw EvidenceRecord payload —
// only the evidence_id reference (ruling rail).
export interface TalentProfileFieldStateReadRow {
  field_key: string;
  value_state: TalentProfileValueState;
  source_type: TalentProfileSourceType;
  projection_policy: TalentProfileProjectionPolicy;
  resolution_status: TalentProfileResolutionStatus;
  resolution_reason: TalentProfileResolutionReason | null;
  proposed_value: string | null;
  provenance: { evidence_id: string } | null;
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

  // TALENT-INTEL-1 TI-1D-B — the field-state READ MODEL: the union of a record's
  // per-field control states and its field→evidence provenance rows, one merged
  // row per field_key. A field with a control row but no provenance reads
  // provenance=null; a field with provenance but no control row reads the default
  // control (UNKNOWN / RECONCILED / AUTO / NONE) — reconcile projected it, so its
  // linkage is real even without an explicit recruiter control. current_value is
  // added by the controller from the canonical getById projection.
  async getFieldStateReadModel(
    talentRecordId: string,
  ): Promise<TalentProfileFieldStateReadRow[]> {
    const [stateRows, provenanceRows] = await Promise.all([
      this.prisma.talentProfileFieldState.findMany({
        where: { talent_record_id: talentRecordId },
        select: {
          field_key: true,
          value_state: true,
          source_type: true,
          projection_policy: true,
          resolution_status: true,
          resolution_reason: true,
          proposed_value: true,
        },
      }),
      this.prisma.talentRecordFieldProvenance.findMany({
        where: { talent_record_id: talentRecordId },
        select: { field_name: true, evidence_id: true },
      }),
    ]);

    const provenanceByField = new Map(
      provenanceRows.map((p) => [p.field_name, p.evidence_id]),
    );
    const byField = new Map<string, TalentProfileFieldStateReadRow>();

    for (const s of stateRows) {
      const evidenceId = provenanceByField.get(s.field_key);
      byField.set(s.field_key, {
        field_key: s.field_key,
        value_state: s.value_state as TalentProfileValueState,
        source_type: s.source_type as TalentProfileSourceType,
        projection_policy: s.projection_policy as TalentProfileProjectionPolicy,
        resolution_status: s.resolution_status as TalentProfileResolutionStatus,
        resolution_reason:
          (s.resolution_reason as TalentProfileResolutionReason | null) ?? null,
        proposed_value: s.proposed_value ?? null,
        provenance: evidenceId !== undefined ? { evidence_id: evidenceId } : null,
      });
    }

    // Provenance-only fields (reconcile projected, no explicit control): default
    // control state, real evidence linkage.
    for (const p of provenanceRows) {
      if (byField.has(p.field_name)) continue;
      byField.set(p.field_name, {
        field_key: p.field_name,
        value_state: 'UNKNOWN',
        source_type: 'RECONCILED',
        projection_policy: 'AUTO',
        resolution_status: 'NONE',
        resolution_reason: null,
        proposed_value: null,
        provenance: { evidence_id: p.evidence_id },
      });
    }

    return [...byField.values()].sort((a, b) => a.field_key.localeCompare(b.field_key));
  }

  // TALENT-INTEL-1 TI-1D-B — record the PENDING_REVIEW resolution summary for a
  // field when reconcile finds evidence it may NOT project (occupied-differing, or
  // an EXPLICITLY_CLEARED / HOLD slot). Sets ONLY the resolution columns +
  // proposed_value; on an EXISTING row it NEVER touches value_state / source_type /
  // projection_policy (a recruiter EXPLICITLY_CLEARED / HOLD control is preserved).
  // On create (no prior control row) the field reads UNKNOWN / RECONCILED / AUTO.
  async markFieldPendingReview(args: {
    tenant_id: string;
    talent_record_id: string;
    field_key: string;
    proposed_value: string;
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
        value_state: 'UNKNOWN',
        source_type: 'RECONCILED',
        // TALENT-INTEL-1 TI-1F-C §4-I — an unresolved contradiction FREEZES
        // automatic projection: HOLD, not AUTO. A field with conflicting evidence
        // must not continue auto-projecting until the conflict is resolved.
        projection_policy: 'HOLD',
        resolution_status: 'PENDING_REVIEW',
        resolution_reason: 'EVIDENCE_CONFLICT',
        proposed_value: args.proposed_value,
      },
      update: {
        // §4-I — also freeze projection on an EXISTING field that just gained a
        // contradiction (value_state / source_type are left untouched — only the
        // projection is held).
        projection_policy: 'HOLD',
        resolution_status: 'PENDING_REVIEW',
        resolution_reason: 'EVIDENCE_CONFLICT',
        proposed_value: args.proposed_value,
      },
    });
  }

  // TALENT-INTEL-1 TI-1D-B / TI-1F-C §4-I — resolve a field's pending review:
  // RESOLVED + the recruiter's reason, CLEAR proposed_value (populated only while
  // PENDING_REVIEW), and release the CONTRADICTION-induced HOLD → AUTO so automatic
  // projection resumes on the resolved value. Two writes so the release is precise:
  //   1. RESOLVED + reason + proposed_value cleared — for every matching row.
  //   2. projection_policy → AUTO ONLY where value_state <> EXPLICITLY_CLEARED —
  //      i.e., release only a contradiction-induced HOLD. A recruiter's MANUAL
  //      EXPLICITLY_CLEARED + HOLD control is PRESERVED (§4-I: never globally clear
  //      a HOLD; the manual clear is a standing recruiter control, distinct from
  //      the contradiction freeze). updateMany over EXISTING rows only (a field with
  //      no control row is a no-op); value_state / source_type are never mutated.
  async resolveFieldReview(args: {
    tenant_id: string;
    talent_record_id: string;
    field_key: string;
    resolution_reason: TalentProfileResolutionReason;
  }): Promise<void> {
    const key = {
      tenant_id: args.tenant_id,
      talent_record_id: args.talent_record_id,
      field_key: args.field_key,
    };
    await this.prisma.talentProfileFieldState.updateMany({
      where: key,
      data: {
        resolution_status: 'RESOLVED',
        resolution_reason: args.resolution_reason,
        proposed_value: null,
      },
    });
    // Release only the contradiction HOLD; preserve a recruiter's manual clear.
    await this.prisma.talentProfileFieldState.updateMany({
      where: { ...key, value_state: { not: 'EXPLICITLY_CLEARED' } },
      data: { projection_policy: 'AUTO' },
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
