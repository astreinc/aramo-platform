import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';

import { PrismaService } from '../prisma/prisma.service.js';

// ATI-SEP-1 T8 (ADR-0036 §3) — the talent_record-side store of the ATS ↔ Talent
// Intelligence integration:
//   * the ADMISSIBLE read of a TalentRecord (an explicit column allowlist: the
//     Class C columns — notes, pay, source, is_hot, address/address2/zip, … —
//     are never even selected, so they cannot reach a payload by accident);
//   * intelligence_link (tenant, talent) → Golden subject;
//   * the inbound webhook inbox (idempotent on the delivery event_id; drained
//     by the worker under a lease);
//   * the per-tenant inbound sync policy rows;
//   * the INBOUND writes: an AUTO_APPLY value (TalentRecord column + provenance
//     source_kind INTELLIGENCE + field state RECONCILED) and a REVIEW value
//     (TalentRecordReconcileContradiction source_kind INTELLIGENCE + the field's
//     PENDING_REVIEW summary). Neither write emits a talent.* outbox event: a
//     value TI supplied is not an ATS business fact, and echoing it back to TI
//     as ATS evidence would self-corroborate (the publisher also skips every
//     field whose provenance is INTELLIGENCE).

/** The TalentRecord columns the publisher may read (Class A / B sources only). */
export interface AdmissibleTalentRecord {
  id: string;
  tenant_id: string;
  record_status: string;
  first_name: string;
  last_name: string;
  email1: string | null;
  email2: string | null;
  phone_cell: string | null;
  phone_home: string | null;
  phone_work: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  current_employer: string | null;
  title: string | null;
  web_site: string | null;
  availability_status: string | null;
  date_available: Date | null;
  work_authorization: string | null;
  updated_at: Date;
}

const ADMISSIBLE_SELECT = {
  id: true,
  tenant_id: true,
  record_status: true,
  first_name: true,
  last_name: true,
  email1: true,
  email2: true,
  phone_cell: true,
  phone_home: true,
  phone_work: true,
  city: true,
  state: true,
  country: true,
  current_employer: true,
  title: true,
  web_site: true,
  availability_status: true,
  date_available: true,
  work_authorization: true,
  updated_at: true,
} as const;

/** TalentRecord columns an inbound AUTO_APPLY may write (never a Class C column). */
export const INTELLIGENCE_WRITABLE_COLUMNS = [
  'first_name',
  'last_name',
  'email1',
  'phone_cell',
  'city',
  'state',
  'country',
  'current_employer',
  'title',
  'web_site',
  'key_skills',
  'availability_status',
  'date_available',
] as const;
export type IntelligenceWritableColumn = (typeof INTELLIGENCE_WRITABLE_COLUMNS)[number];

export const INTELLIGENCE_SOURCE_KIND = 'INTELLIGENCE';

export type InboundEventStatus = 'RECEIVED' | 'APPLIED' | 'SKIPPED' | 'QUARANTINED';

export interface InboundEventRow {
  event_id: string;
  tenant_id: string;
  talent_record_id: string;
  intelligence_subject_id: string;
  changed_fact_types: string[];
  occurred_at: Date;
  attempts: number;
}

export type SyncPolicyMode = 'AUTO_APPLY' | 'REVIEW' | 'IGNORE';

/**
 * A deterministic UUID-shaped reference for an INTELLIGENCE provenance /
 * contradiction row (the columns are uuid, and the value is never a trust
 * EvidenceRecord id). Same (subject, field, value) → same id → idempotent.
 */
export function intelligenceReferenceId(parts: readonly string[]): string {
  const h = createHash('sha256').update(parts.join('\u001f'), 'utf8').digest('hex');
  // RFC 4122 layout, version nibble 8 (custom), variant 10xx.
  const variant = ((parseInt(h.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

@Injectable()
export class TalentIntelligenceRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ── publisher reads ────────────────────────────────────────────────────────

  async readAdmissibleRecord(args: { tenant_id: string; id: string }): Promise<AdmissibleTalentRecord | null> {
    const row = await this.prisma.talentRecord.findFirst({
      where: { id: args.id, tenant_id: args.tenant_id },
      select: ADMISSIBLE_SELECT,
    });
    return row ?? null;
  }

  /** Fields whose CURRENT value came from Talent Intelligence (never echoed back). */
  async listIntelligenceSourcedFields(talentRecordId: string): Promise<Set<string>> {
    const rows = await this.prisma.talentRecordFieldProvenance.findMany({
      where: { talent_record_id: talentRecordId, source_kind: INTELLIGENCE_SOURCE_KIND },
      select: { field_name: true },
    });
    return new Set(rows.map((r) => r.field_name));
  }

  // ── intelligence_link ──────────────────────────────────────────────────────

  async findLink(args: { tenant_id: string; talent_record_id: string }): Promise<{ intelligence_subject_id: string; linked_at: Date; last_synced_at: Date | null } | null> {
    return this.prisma.intelligenceLink.findUnique({
      where: { tenant_id_talent_record_id: { tenant_id: args.tenant_id, talent_record_id: args.talent_record_id } },
      select: { intelligence_subject_id: true, linked_at: true, last_synced_at: true },
    });
  }

  /** Upsert the link; a changed subject (TI merge / split) re-points it. No-op for an absent record. */
  async upsertLink(args: {
    tenant_id: string;
    talent_record_id: string;
    intelligence_subject_id: string;
    synced_at?: Date;
  }): Promise<boolean> {
    const exists = await this.prisma.talentRecord.count({ where: { id: args.talent_record_id, tenant_id: args.tenant_id } });
    if (exists === 0) return false;
    await this.prisma.intelligenceLink.upsert({
      where: { tenant_id_talent_record_id: { tenant_id: args.tenant_id, talent_record_id: args.talent_record_id } },
      create: {
        tenant_id: args.tenant_id,
        talent_record_id: args.talent_record_id,
        intelligence_subject_id: args.intelligence_subject_id,
        ...(args.synced_at ? { last_synced_at: args.synced_at } : {}),
      },
      update: {
        intelligence_subject_id: args.intelligence_subject_id,
        ...(args.synced_at ? { last_synced_at: args.synced_at } : {}),
      },
    });
    return true;
  }

  // ── inbound inbox ──────────────────────────────────────────────────────────

  /** Insert a received delivery. 'duplicate' when the event_id was already received (any status). */
  async recordInboundEvent(row: {
    event_id: string;
    tenant_id: string;
    talent_record_id: string;
    intelligence_subject_id: string;
    changed_fact_types: readonly string[];
    occurred_at: Date;
  }): Promise<'created' | 'duplicate'> {
    const inserted = await this.prisma.$executeRawUnsafe(
      `INSERT INTO "talent_record"."talent_intelligence_inbound_event"
         ("event_id", "tenant_id", "talent_record_id", "intelligence_subject_id", "changed_fact_types", "occurred_at")
       VALUES ($1, $2::uuid, $3::uuid, $4::uuid, $5::text[], $6::timestamptz)
       ON CONFLICT ("event_id") DO NOTHING`,
      row.event_id,
      row.tenant_id,
      row.talent_record_id,
      row.intelligence_subject_id,
      [...row.changed_fact_types],
      row.occurred_at,
    );
    return inserted > 0 ? 'created' : 'duplicate';
  }

  /** Lease up to `limit` RECEIVED rows whose lease is free (FOR UPDATE SKIP LOCKED — multi-replica safe). */
  async claimInboundEvents(args: { limit: number; lease_seconds: number; now?: Date }): Promise<InboundEventRow[]> {
    const now = args.now ?? new Date();
    const rows = await this.prisma.$queryRawUnsafe<
      Array<{
        event_id: string;
        tenant_id: string;
        talent_record_id: string;
        intelligence_subject_id: string;
        changed_fact_types: string[];
        occurred_at: Date;
        attempts: number;
      }>
    >(
      `UPDATE "talent_record"."talent_intelligence_inbound_event" e
          SET "lease_expires_at" = $2::timestamptz + make_interval(secs => $3::int),
              "attempts" = e."attempts" + 1
        WHERE e."event_id" IN (
          SELECT "event_id" FROM "talent_record"."talent_intelligence_inbound_event"
           WHERE "status" = 'RECEIVED'
             AND ("lease_expires_at" IS NULL OR "lease_expires_at" <= $2::timestamptz)
           ORDER BY "received_at" ASC
           LIMIT $1
           FOR UPDATE SKIP LOCKED)
       RETURNING e."event_id", e."tenant_id"::text AS tenant_id, e."talent_record_id"::text AS talent_record_id,
                 e."intelligence_subject_id"::text AS intelligence_subject_id, e."changed_fact_types",
                 e."occurred_at", e."attempts"`,
      args.limit,
      now,
      args.lease_seconds,
    );
    return rows;
  }

  async completeInboundEvent(args: { event_id: string; status: Exclude<InboundEventStatus, 'RECEIVED'>; outcome: string; error?: string; now?: Date }): Promise<void> {
    await this.prisma.talentIntelligenceInboundEvent.update({
      where: { event_id: args.event_id },
      data: {
        status: args.status,
        outcome: args.outcome,
        processed_at: args.now ?? new Date(),
        lease_expires_at: null,
        last_error: args.error ?? null,
      },
    });
  }

  /** A transient failure: keep RECEIVED, hold the lease for the backoff, record the reason. */
  async retryInboundEventLater(args: { event_id: string; error: string; retry_at: Date }): Promise<void> {
    await this.prisma.talentIntelligenceInboundEvent.update({
      where: { event_id: args.event_id },
      data: { lease_expires_at: args.retry_at, last_error: args.error.slice(0, 500) },
    });
  }

  async findInboundEvent(eventId: string): Promise<{ status: string; outcome: string | null; attempts: number } | null> {
    return this.prisma.talentIntelligenceInboundEvent.findUnique({
      where: { event_id: eventId },
      select: { status: true, outcome: true, attempts: true },
    });
  }

  // ── sync policy ────────────────────────────────────────────────────────────

  async listSyncPolicy(tenantId: string): Promise<Map<string, SyncPolicyMode>> {
    const rows = await this.prisma.talentIntelligenceSyncPolicy.findMany({
      where: { tenant_id: tenantId },
      select: { field_key: true, mode: true },
    });
    return new Map(rows.map((r) => [r.field_key, r.mode as SyncPolicyMode]));
  }

  async setSyncPolicy(args: { tenant_id: string; field_key: string; mode: SyncPolicyMode; updated_by?: string | null }): Promise<void> {
    await this.prisma.talentIntelligenceSyncPolicy.upsert({
      where: { tenant_id_field_key: { tenant_id: args.tenant_id, field_key: args.field_key } },
      create: { tenant_id: args.tenant_id, field_key: args.field_key, mode: args.mode, updated_by: args.updated_by ?? null },
      update: { mode: args.mode, updated_by: args.updated_by ?? null, updated_at: new Date() },
    });
  }

  // ── inbound writes ─────────────────────────────────────────────────────────

  /** The current values of the writable columns (for the empty / equal checks). */
  async readWritableValues(args: { tenant_id: string; talent_record_id: string }): Promise<Record<IntelligenceWritableColumn, string | Date | null> | null> {
    const row = await this.prisma.talentRecord.findFirst({
      where: { id: args.talent_record_id, tenant_id: args.tenant_id },
      select: Object.fromEntries(INTELLIGENCE_WRITABLE_COLUMNS.map((c) => [c, true])) as Record<IntelligenceWritableColumn, true>,
    });
    return (row as Record<IntelligenceWritableColumn, string | Date | null> | null) ?? null;
  }

  /**
   * AUTO_APPLY one field: write its columns and, PER COLUMN, mark provenance
   * INTELLIGENCE and the control state RECONCILED / SET (projection policy left
   * as it is; AUTO on create), in ONE transaction. The caller has already proved
   * the field is empty or machine-sourced (never recruiter-confirmed).
   */
  async applyIntelligenceField(args: {
    tenant_id: string;
    talent_record_id: string;
    columns: Partial<Record<IntelligenceWritableColumn, string | Date>>;
    reference_id: string;
  }): Promise<void> {
    const data: Record<string, string | Date> = {};
    for (const [k, v] of Object.entries(args.columns)) {
      if (!(INTELLIGENCE_WRITABLE_COLUMNS as readonly string[]).includes(k)) {
        throw new Error(`intelligence inbound: column ${k} is not writable`);
      }
      if (v !== undefined) data[k] = v;
    }
    const columns = Object.keys(data);
    if (columns.length === 0) return;
    await this.prisma.$transaction(async (tx) => {
      await tx.talentRecord.updateMany({ where: { id: args.talent_record_id, tenant_id: args.tenant_id }, data });
      for (const column of columns) {
        await tx.talentRecordFieldProvenance.upsert({
          where: { talent_record_id_field_name: { talent_record_id: args.talent_record_id, field_name: column } },
          create: {
            id: uuidv7(),
            tenant_id: args.tenant_id,
            talent_record_id: args.talent_record_id,
            field_name: column,
            evidence_id: args.reference_id,
            source_kind: INTELLIGENCE_SOURCE_KIND,
          },
          update: { evidence_id: args.reference_id, source_kind: INTELLIGENCE_SOURCE_KIND, updated_at: new Date() },
        });
        await tx.talentProfileFieldState.upsert({
          where: {
            tenant_id_talent_record_id_field_key: {
              tenant_id: args.tenant_id,
              talent_record_id: args.talent_record_id,
              field_key: column,
            },
          },
          create: {
            tenant_id: args.tenant_id,
            talent_record_id: args.talent_record_id,
            field_key: column,
            value_state: 'SET',
            source_type: 'RECONCILED',
            projection_policy: 'AUTO',
          },
          update: { value_state: 'SET', source_type: 'RECONCILED' },
        });
      }
    });
  }

  /**
   * REVIEW one field: an INTELLIGENCE contradiction row (idempotent on the
   * reference id) + the field's PENDING_REVIEW summary with the proposed value.
   * The ATS value is NEVER touched. Returns false when the same proposal was
   * already recorded.
   */
  async recordIntelligenceReview(args: {
    tenant_id: string;
    talent_record_id: string;
    field_key: string;
    proposed_value: string;
    reference_id: string;
  }): Promise<boolean> {
    const proposed = args.proposed_value.slice(0, 2000);
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.talentRecordReconcileContradiction.findUnique({
        where: {
          talent_record_id_field_name_new_evidence_id: {
            talent_record_id: args.talent_record_id,
            field_name: args.field_key,
            new_evidence_id: args.reference_id,
          },
        },
        select: { id: true },
      });
      if (existing !== null) return false;
      await tx.talentRecordReconcileContradiction.create({
        data: {
          id: uuidv7(),
          tenant_id: args.tenant_id,
          talent_record_id: args.talent_record_id,
          field_name: args.field_key,
          new_evidence_id: args.reference_id,
          status: 'pending',
          source_kind: INTELLIGENCE_SOURCE_KIND,
          proposed_value: proposed,
        },
      });
      await tx.talentProfileFieldState.upsert({
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
          projection_policy: 'HOLD',
          resolution_status: 'PENDING_REVIEW',
          resolution_reason: 'EVIDENCE_CONFLICT',
          proposed_value: proposed,
        },
        // value_state / source_type / projection_policy untouched on an existing
        // row (a recruiter control is preserved); only the review summary moves.
        update: { resolution_status: 'PENDING_REVIEW', resolution_reason: 'EVIDENCE_CONFLICT', proposed_value: proposed },
      });
      return true;
    });
  }
}
