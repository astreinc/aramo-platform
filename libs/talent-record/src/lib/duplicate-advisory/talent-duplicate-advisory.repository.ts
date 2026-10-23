import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';

import { PrismaService } from '../prisma/prisma.service.js';
import { normalizePhoneForDedupe } from '../talent-phone.js';

// ATI-SEP-1 T10 WP2 (Addenda A2 F-1 / A3) — the ATS-local within-tenant duplicate
// advisory store + the sourced-arrival → TalentRecord link store. Everything here
// is computed from ATS data (talent_record + sourced_talent); no Talent
// Intelligence output reads or gates it.
//
// An advisory is a reviewer prompt, never an automatic action: PENDING_REVIEW →
// APPROVED (the apps/api orchestrator re-homes onto the survivor) | DISMISSED;
// APPROVED → REVERSED (the orchestrator undoes the re-home). Ids + named kinds
// only — a contact value is never stored or returned.

export const DUPLICATE_ADVISORY_STATUSES = [
  'PENDING_REVIEW',
  'APPROVED',
  'DISMISSED',
  'REVERSED',
] as const;
export type DuplicateAdvisoryStatus = (typeof DUPLICATE_ADVISORY_STATUSES)[number];

export const DUPLICATE_ADVISORY_BASES = ['EMAIL', 'PHONE', 'SOURCED_ARRIVAL'] as const;
export type DuplicateAdvisoryBasis = (typeof DUPLICATE_ADVISORY_BASES)[number];

// The shared-contact kinds a pair is flagged on (named kinds, never values).
export type DuplicateSharedKind = 'EMAIL' | 'PHONE';

// The durable re-home checkpoint (resumable + reversible). Each sweep step
// records the holder rows it re-pointed and any collision rows it removed.
export interface DuplicateAdvisoryMergeState {
  sweep_steps: Array<{ domain: string; repointed_ids: string[]; removed_rows: unknown[] }>;
  collision_records: Array<{ domain: string; row: unknown }>;
  post_merge_accretions?: Array<{ domain: string; ids: string[] }>;
}

export interface DuplicateAdvisoryRow {
  id: string;
  tenant_id: string;
  talent_record_a_id: string;
  talent_record_b_id: string | null;
  sourced_talent_id: string | null;
  basis: DuplicateAdvisoryBasis;
  shared_kinds: string[];
  status: DuplicateAdvisoryStatus;
  decided_by: string | null;
  decided_at: Date | null;
  justification: string | null;
  surviving_record_id: string | null;
  superseded_record_id: string | null;
  merge_state: DuplicateAdvisoryMergeState | null;
  merge_completed_at: Date | null;
  reversed_by: string | null;
  reversed_at: Date | null;
  reversal_justification: string | null;
  created_at: Date;
  updated_at: Date;
}

export type SourcedArrivalLinkKind = 'PROMOTED' | 'ADVISORY_APPROVED';

export interface SourcedArrivalLinkRow {
  tenant_id: string;
  sourced_talent_id: string;
  talent_record_id: string;
  link_kind: SourcedArrivalLinkKind;
  advisory_id: string | null;
  linked_by: string | null;
  created_at: Date;
}

// The live-record contact a detector run compares (never returned on a wire).
export interface RecordContactKeys {
  id: string;
  record_status: string;
  email: string | null;
  phone: string | null;
}

// Every digit form a normalized dedupe phone matches in sourced_talent (which
// stores bare digits): the dedupe key itself, plus the 10-digit form of a
// leading-1 11-digit key.
export function phoneLookupForms(dedupePhone: string | null): string[] {
  if (dedupePhone === null) return [];
  const out = new Set<string>([dedupePhone]);
  if (dedupePhone.length === 11 && dedupePhone.startsWith('1')) out.add(dedupePhone.slice(1));
  return [...out];
}

function canonicalPair(x: string, y: string): [string, string] {
  return x < y ? [x, y] : [y, x];
}

function toRow(r: unknown): DuplicateAdvisoryRow {
  return r as DuplicateAdvisoryRow;
}

@Injectable()
export class TalentDuplicateAdvisoryRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ---- detector reads ---------------------------------------------------------

  /** The contact keys of one record (tenant-scoped); null when absent. */
  async findRecordContactKeys(tenantId: string, id: string): Promise<RecordContactKeys | null> {
    const r = await this.prisma.talentRecord.findFirst({
      where: { tenant_id: tenantId, id },
      select: { id: true, record_status: true, email1: true, phone_cell_normalized: true },
    });
    if (r === null) return null;
    const email = (r.email1 ?? '').trim().toLowerCase();
    return {
      id: r.id,
      record_status: r.record_status,
      email: email === '' ? null : email,
      phone: r.phone_cell_normalized ?? null,
    };
  }

  /**
   * The OTHER live records in the tenant sharing the primary email
   * (case-insensitive) and/or the normalized cell phone, with the kinds each
   * shares. Tenant-scoped by construction — a record in another tenant is never
   * a match.
   */
  async findLiveContactMatches(input: {
    tenant_id: string;
    exclude_id?: string;
    email: string | null;
    phone: string | null;
  }): Promise<Array<{ id: string; kinds: DuplicateSharedKind[] }>> {
    const or: Array<Record<string, unknown>> = [];
    if (input.email !== null && input.email !== '') {
      or.push({ email1: { equals: input.email, mode: 'insensitive' } });
    }
    if (input.phone !== null && input.phone !== '') or.push({ phone_cell_normalized: input.phone });
    if (or.length === 0) return [];
    const rows = await this.prisma.talentRecord.findMany({
      where: {
        tenant_id: input.tenant_id,
        record_status: 'live',
        ...(input.exclude_id !== undefined ? { id: { not: input.exclude_id } } : {}),
        OR: or as never,
      },
      select: { id: true, email1: true, phone_cell_normalized: true },
      orderBy: { id: 'asc' },
      take: 50,
    });
    return rows.map((r) => {
      const kinds: DuplicateSharedKind[] = [];
      if (input.email !== null && (r.email1 ?? '').trim().toLowerCase() === input.email) kinds.push('EMAIL');
      if (input.phone !== null && r.phone_cell_normalized === input.phone) kinds.push('PHONE');
      return { id: r.id, kinds };
    });
  }

  // ---- advisory writes ------------------------------------------------------------

  /**
   * Record a PENDING_REVIEW advisory for a record pair, idempotently (the
   * canonical-pair unique key). An existing advisory for the pair — whatever its
   * status — is left untouched (a dismissed pair is not re-raised). Returns
   * true when a new advisory was written.
   */
  async upsertPendingPair(input: {
    tenant_id: string;
    record_x: string;
    record_y: string;
    kinds: readonly DuplicateSharedKind[];
  }): Promise<boolean> {
    if (input.record_x === input.record_y || input.kinds.length === 0) return false;
    const [a, b] = canonicalPair(input.record_x, input.record_y);
    const res = await this.prisma.talentDuplicateAdvisory.createMany({
      data: [
        {
          id: uuidv7(),
          tenant_id: input.tenant_id,
          talent_record_a_id: a,
          talent_record_b_id: b,
          basis: input.kinds.includes('EMAIL') ? 'EMAIL' : 'PHONE',
          shared_kinds: [...new Set(input.kinds)],
        },
      ],
      skipDuplicates: true,
    });
    return res.count > 0;
  }

  /**
   * Record a PENDING_REVIEW advisory that a sourced arrival may be an existing
   * live record's human (basis SOURCED_ARRIVAL). Idempotent on (tenant, record,
   * arrival). Returns true when a new advisory was written.
   */
  async upsertPendingArrival(input: {
    tenant_id: string;
    talent_record_id: string;
    sourced_talent_id: string;
    kinds: readonly DuplicateSharedKind[];
  }): Promise<boolean> {
    if (input.kinds.length === 0) return false;
    const res = await this.prisma.talentDuplicateAdvisory.createMany({
      data: [
        {
          id: uuidv7(),
          tenant_id: input.tenant_id,
          talent_record_a_id: input.talent_record_id,
          sourced_talent_id: input.sourced_talent_id,
          basis: 'SOURCED_ARRIVAL',
          shared_kinds: [...new Set(input.kinds)],
        },
      ],
      skipDuplicates: true,
    });
    return res.count > 0;
  }

  /**
   * Conditional status transition (compare-and-set on the current status). Returns
   * the updated row, or null when the advisory is absent / not in `from`.
   */
  async transition(input: {
    tenant_id: string;
    id: string;
    from: readonly DuplicateAdvisoryStatus[];
    data: {
      status: DuplicateAdvisoryStatus;
      decided_by?: string | null;
      decided_at?: Date | null;
      justification?: string | null;
      surviving_record_id?: string | null;
      superseded_record_id?: string | null;
      merge_state?: DuplicateAdvisoryMergeState | null;
      merge_completed_at?: Date | null;
      reversed_by?: string | null;
      reversed_at?: Date | null;
      reversal_justification?: string | null;
    };
  }): Promise<DuplicateAdvisoryRow | null> {
    const res = await this.prisma.talentDuplicateAdvisory.updateMany({
      where: { tenant_id: input.tenant_id, id: input.id, status: { in: [...input.from] } },
      data: input.data as never,
    });
    if (res.count === 0) return null;
    return this.findById(input.tenant_id, input.id);
  }

  /** Persist the re-home checkpoint (and optionally its completion stamp). */
  async updateMergeState(input: {
    tenant_id: string;
    id: string;
    merge_state: DuplicateAdvisoryMergeState;
    merge_completed_at?: Date;
  }): Promise<DuplicateAdvisoryRow | null> {
    await this.prisma.talentDuplicateAdvisory.updateMany({
      where: { tenant_id: input.tenant_id, id: input.id },
      data: {
        merge_state: input.merge_state as never,
        ...(input.merge_completed_at !== undefined
          ? { merge_completed_at: input.merge_completed_at }
          : {}),
      },
    });
    return this.findById(input.tenant_id, input.id);
  }

  // ---- advisory reads -------------------------------------------------------------

  async findById(tenantId: string, id: string): Promise<DuplicateAdvisoryRow | null> {
    const r = await this.prisma.talentDuplicateAdvisory.findFirst({ where: { tenant_id: tenantId, id } });
    return r === null ? null : toRow(r);
  }

  /**
   * ATI-SEP-1 T10 WP4 — the oldest PENDING_REVIEW advisory naming this record (as
   * either side of a record pair, or as the record of an arrival advisory);
   * tenant-scoped; null when none. The Talent 360 identity-outcome pointer.
   */
  async findPendingForRecord(tenantId: string, recordId: string): Promise<DuplicateAdvisoryRow | null> {
    const r = await this.prisma.talentDuplicateAdvisory.findFirst({
      where: {
        tenant_id: tenantId,
        status: 'PENDING_REVIEW',
        OR: [{ talent_record_a_id: recordId }, { talent_record_b_id: recordId }],
      },
      orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
    });
    return r === null ? null : toRow(r);
  }

  /** Every advisory naming this sourced arrival (newest first), optionally by status. */
  async listForArrival(
    tenantId: string,
    sourcedTalentId: string,
    status?: DuplicateAdvisoryStatus,
  ): Promise<DuplicateAdvisoryRow[]> {
    const rows = await this.prisma.talentDuplicateAdvisory.findMany({
      where: {
        tenant_id: tenantId,
        sourced_talent_id: sourcedTalentId,
        ...(status !== undefined ? { status } : {}),
      },
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
    });
    return rows.map(toRow);
  }

  /** PENDING_REVIEW advisory counts per arrival (one grouped read — the pool page). */
  async countPendingByArrivals(tenantId: string, ids: readonly string[]): Promise<Map<string, number>> {
    if (ids.length === 0) return new Map();
    const rows = await this.prisma.talentDuplicateAdvisory.groupBy({
      by: ['sourced_talent_id'],
      where: { tenant_id: tenantId, status: 'PENDING_REVIEW', sourced_talent_id: { in: [...ids] } },
      _count: { _all: true },
    });
    const out = new Map<string, number>();
    for (const r of rows) {
      if (r.sourced_talent_id !== null) out.set(r.sourced_talent_id, r._count._all);
    }
    return out;
  }

  /**
   * The reviewer worklist page: a tenant's advisories in `status`, oldest first,
   * keyset-paginated on (created_at, id). next_cursor is opaque (null on the
   * last page).
   */
  async listKeyset(input: {
    tenant_id: string;
    status: DuplicateAdvisoryStatus;
    limit: number;
    cursor?: string;
  }): Promise<{ rows: DuplicateAdvisoryRow[]; nextCursor: string | null }> {
    const c = decodeCursor(input.cursor ?? null);
    const rows = await this.prisma.talentDuplicateAdvisory.findMany({
      where: {
        tenant_id: input.tenant_id,
        status: input.status,
        ...(c === null
          ? {}
          : {
              OR: [
                { created_at: { gt: c.created_at } },
                { created_at: c.created_at, id: { gt: c.id } },
              ],
            }),
      },
      orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
      take: input.limit + 1,
    });
    const page = rows.slice(0, input.limit).map(toRow);
    const last = page[page.length - 1];
    const nextCursor =
      rows.length > input.limit && last !== undefined ? encodeCursor(last.created_at, last.id) : null;
    return { rows: page, nextCursor };
  }

  // ---- sourced-arrival links ---------------------------------------------------------

  async findArrivalLink(tenantId: string, sourcedTalentId: string): Promise<SourcedArrivalLinkRow | null> {
    const r = await this.prisma.talentRecordSourcedArrival.findUnique({
      where: { tenant_id_sourced_talent_id: { tenant_id: tenantId, sourced_talent_id: sourcedTalentId } },
    });
    return (r as SourcedArrivalLinkRow | null) ?? null;
  }

  /** Which of these arrivals already link to a TalentRecord (the pool anti-join). */
  async findLinkedArrivalIds(tenantId: string, ids: readonly string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const rows = await this.prisma.talentRecordSourcedArrival.findMany({
      where: { tenant_id: tenantId, sourced_talent_id: { in: [...ids] } },
      select: { sourced_talent_id: true },
    });
    return new Set(rows.map((r) => r.sourced_talent_id));
  }

  /**
   * Link an arrival to an existing record on an APPROVED SOURCED_ARRIVAL advisory.
   * Idempotent: an arrival already linked keeps its first link (returned).
   */
  async linkArrivalByAdvisory(input: {
    tenant_id: string;
    sourced_talent_id: string;
    talent_record_id: string;
    advisory_id: string;
    linked_by: string | null;
  }): Promise<SourcedArrivalLinkRow> {
    await this.prisma.talentRecordSourcedArrival.createMany({
      data: [
        {
          tenant_id: input.tenant_id,
          sourced_talent_id: input.sourced_talent_id,
          talent_record_id: input.talent_record_id,
          link_kind: 'ADVISORY_APPROVED',
          advisory_id: input.advisory_id,
          linked_by: input.linked_by,
        },
      ],
      skipDuplicates: true,
    });
    const link = await this.findArrivalLink(input.tenant_id, input.sourced_talent_id);
    return link as SourcedArrivalLinkRow;
  }

  /** Remove the link an approval wrote (reversal). Only that advisory's link. */
  async unlinkArrivalByAdvisory(input: {
    tenant_id: string;
    sourced_talent_id: string;
    advisory_id: string;
  }): Promise<number> {
    const res = await this.prisma.talentRecordSourcedArrival.deleteMany({
      where: {
        tenant_id: input.tenant_id,
        sourced_talent_id: input.sourced_talent_id,
        advisory_id: input.advisory_id,
        link_kind: 'ADVISORY_APPROVED',
      },
    });
    return res.count;
  }
}

// The dedupe phone key a raw arrival phone maps to (re-exported for callers that
// compare an arrival against a record).
export function arrivalPhoneKey(raw: string | null | undefined): string | null {
  return normalizePhoneForDedupe(raw ?? null);
}

// Opaque keyset cursor = base64url("<created_at ISO>|<id>").
function encodeCursor(created_at: Date, id: string): string {
  return Buffer.from(`${created_at.toISOString()}|${id}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | null): { created_at: Date; id: string } | null {
  if (cursor === null || cursor.length === 0) return null;
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const sep = decoded.indexOf('|');
    if (sep <= 0) return null;
    const created_at = new Date(decoded.slice(0, sep));
    const id = decoded.slice(sep + 1);
    if (id.length === 0 || Number.isNaN(created_at.getTime())) return null;
    return { created_at, id };
  } catch {
    return null;
  }
}
