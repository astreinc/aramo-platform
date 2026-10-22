import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import { PrismaService } from './prisma/prisma.service.js';
import type { TalentEducationSourceValue } from './talent-evidence.repository.js';

// ATS-QA-1 I-4 (L2, amendment A3) — read and recruiter edit of declared education.
//
// TalentEducationEntry stays the ONLY education authority. This repository never
// updates or deletes an entry row:
//   - add      → a new `manual` entry + an `added` audit event
//   - correct  → a new `manual` entry, a retirement of the old entry (reason
//                corrected, pointing at the new one) + a `corrected` audit event
//   - remove   → a retirement of the entry (reason removed) + a `removed` audit event
// Each change is ONE transaction. The retirement primary key is the entry id, so a
// second correction or removal of the same entry (concurrent or late) fails with
// EducationEntryRetiredError and writes nothing.
//
// Every read and write is keyed by tenant AND Talent: an entry of another Talent
// or another tenant is indistinguishable from a missing one.

export type EducationRetireReason = 'corrected' | 'removed';
export type EducationAuditAction = 'added' | 'corrected' | 'removed';

export interface EducationEntryFields {
  institution_name: string;
  degree_name: string;
  field_of_study: string | null;
  // Calendar date (UTC midnight). null = not stated, never guessed.
  conferred_date: Date | null;
}

export interface ActiveEducationEntryRow extends EducationEntryFields {
  id: string;
  talent_id: string;
  tenant_id: string;
  source: TalentEducationSourceValue;
  evidence_text: string | null;
  source_document_id: string | null;
  source_refs: string[];
  source_map_version: string | null;
  resume_text_hash: string | null;
  created_at: Date;
  // The entry this one corrected (its retired predecessor), else null.
  corrects_entry_id: string | null;
}

export interface EducationEntryWithStateRow extends ActiveEducationEntryRow {
  retirement: {
    reason: EducationRetireReason;
    superseded_by_entry_id: string | null;
    retired_at: Date;
  } | null;
}

// Thrown when the target entry is already retired (corrected or removed before).
export class EducationEntryRetiredError extends Error {
  constructor(public readonly entryId: string) {
    super(`education entry ${entryId} is no longer current`);
    this.name = 'EducationEntryRetiredError';
  }
}

const ENTRY_SELECT = {
  id: true,
  talent_id: true,
  tenant_id: true,
  institution_name: true,
  degree_name: true,
  field_of_study: true,
  conferred_date: true,
  evidence_text: true,
  source: true,
  source_document_id: true,
  source_refs: true,
  source_map_version: true,
  resume_text_hash: true,
  created_at: true,
} as const;

type EntryRow = Omit<ActiveEducationEntryRow, 'corrects_entry_id'>;

const isUniqueViolation = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'P2002';

// The two-int advisory-lock class for the education ledger sync. The two-int key
// space never overlaps the single-bigint one, and this class id is used nowhere
// else, so the lock cannot collide with another lock in the platform.
const EDUCATION_LEDGER_LOCK_CLASS = 0x45445543; // 'EDUC'

@Injectable()
export class TalentEducationRepository {
  constructor(private readonly prisma: PrismaService) {}

  // Runs `fn` while holding a per-Talent transaction-scoped advisory lock, so two
  // ledger syncs of the same Talent never run at once (no duplicate claim writes).
  // The lock is released when the holding transaction ends.
  async withLedgerLock<T>(
    args: { tenant_id: string; talent_id: string },
    fn: () => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${EDUCATION_LEDGER_LOCK_CLASS}::int4, hashtext(${`${args.tenant_id}:${args.talent_id}`}))`;
        return fn();
      },
      { timeout: 60_000, maxWait: 30_000 },
    );
  }

  // The CURRENT education of one Talent: every entry without a retirement.
  // Newest conferred first (undated last), then newest recorded first.
  async listActiveForTalent(args: {
    tenant_id: string;
    talent_id: string;
  }): Promise<ActiveEducationEntryRow[]> {
    const all = await this.listAllForTalent(args);
    return all
      .filter((r) => r.retirement === null)
      .map((r) => {
        const row: ActiveEducationEntryRow & { retirement?: unknown } = { ...r };
        delete row.retirement;
        return row;
      });
  }

  // Every entry of one Talent, current and retired, with its retirement state.
  // The edit service uses it for the ledger sync (history included).
  async listAllForTalent(args: {
    tenant_id: string;
    talent_id: string;
  }): Promise<EducationEntryWithStateRow[]> {
    const rows = (await this.prisma.talentEducationEntry.findMany({
      where: { tenant_id: args.tenant_id, talent_id: args.talent_id },
      select: ENTRY_SELECT,
    })) as EntryRow[];
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const [retired, corrections] = await Promise.all([
      this.prisma.educationEntryRetirement.findMany({
        where: { tenant_id: args.tenant_id, entry_id: { in: ids } },
      }),
      this.prisma.educationEntryRetirement.findMany({
        where: { tenant_id: args.tenant_id, superseded_by_entry_id: { in: ids } },
        select: { entry_id: true, superseded_by_entry_id: true },
      }),
    ]);
    const retiredBy = new Map(retired.map((r) => [r.entry_id, r]));
    const correctsBy = new Map(
      corrections.map((c) => [c.superseded_by_entry_id as string, c.entry_id]),
    );
    return rows
      .map((r) => {
        const ret = retiredBy.get(r.id);
        return {
          ...r,
          corrects_entry_id: correctsBy.get(r.id) ?? null,
          retirement:
            ret === undefined
              ? null
              : {
                  reason: ret.reason as EducationRetireReason,
                  superseded_by_entry_id: ret.superseded_by_entry_id,
                  retired_at: ret.retired_at,
                },
        };
      })
      .sort(compareEntries);
  }

  // Add a recruiter-entered entry (source manual).
  async addManual(args: {
    tenant_id: string;
    talent_id: string;
    actor_id: string;
    fields: EducationEntryFields;
    now?: Date;
  }): Promise<{ entry_id: string }> {
    const now = args.now ?? new Date();
    const entry_id = randomUUID();
    await this.prisma.$transaction(async (tx) => {
      await tx.talentEducationEntry.create({
        data: manualEntryData(entry_id, args.tenant_id, args.talent_id, args.fields, now),
        select: { id: true },
      });
      await tx.educationEntryAuditEvent.create({
        data: {
          id: randomUUID(),
          tenant_id: args.tenant_id,
          entry_id,
          action: 'added',
          actor_id: args.actor_id,
          related_entry_id: null,
          changed_fields: [],
          occurred_at: now,
        },
      });
    });
    return { entry_id };
  }

  // Correct an entry: a new manual entry replaces it and the old one is retired.
  // Returns null when the entry is not this Talent's in this tenant. Throws
  // EducationEntryRetiredError when it was already corrected or removed.
  async correct(args: {
    tenant_id: string;
    talent_id: string;
    entry_id: string;
    actor_id: string;
    fields: EducationEntryFields;
    changed_fields: string[];
    now?: Date;
  }): Promise<{ entry_id: string; replaced_entry_id: string } | null> {
    const now = args.now ?? new Date();
    const new_id = randomUUID();
    try {
      return await this.prisma.$transaction(async (tx) => {
        const existing = await tx.talentEducationEntry.findFirst({
          where: { id: args.entry_id, tenant_id: args.tenant_id, talent_id: args.talent_id },
          select: { id: true },
        });
        if (existing === null) return null;
        await tx.talentEducationEntry.create({
          data: manualEntryData(new_id, args.tenant_id, args.talent_id, args.fields, now),
          select: { id: true },
        });
        await tx.educationEntryRetirement.create({
          data: {
            entry_id: args.entry_id,
            tenant_id: args.tenant_id,
            reason: 'corrected',
            superseded_by_entry_id: new_id,
            retired_by_id: args.actor_id,
            retired_at: now,
          },
        });
        await tx.educationEntryAuditEvent.create({
          data: {
            id: randomUUID(),
            tenant_id: args.tenant_id,
            entry_id: new_id,
            action: 'corrected',
            actor_id: args.actor_id,
            related_entry_id: args.entry_id,
            changed_fields: args.changed_fields,
            occurred_at: now,
          },
        });
        return { entry_id: new_id, replaced_entry_id: args.entry_id };
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new EducationEntryRetiredError(args.entry_id);
      throw err;
    }
  }

  // Remove an entry: it is retired (kept as history), never deleted. Returns null
  // when the entry is not this Talent's in this tenant.
  async remove(args: {
    tenant_id: string;
    talent_id: string;
    entry_id: string;
    actor_id: string;
    now?: Date;
  }): Promise<{ entry_id: string } | null> {
    const now = args.now ?? new Date();
    try {
      return await this.prisma.$transaction(async (tx) => {
        const existing = await tx.talentEducationEntry.findFirst({
          where: { id: args.entry_id, tenant_id: args.tenant_id, talent_id: args.talent_id },
          select: { id: true },
        });
        if (existing === null) return null;
        await tx.educationEntryRetirement.create({
          data: {
            entry_id: args.entry_id,
            tenant_id: args.tenant_id,
            reason: 'removed',
            superseded_by_entry_id: null,
            retired_by_id: args.actor_id,
            retired_at: now,
          },
        });
        await tx.educationEntryAuditEvent.create({
          data: {
            id: randomUUID(),
            tenant_id: args.tenant_id,
            entry_id: args.entry_id,
            action: 'removed',
            actor_id: args.actor_id,
            related_entry_id: null,
            changed_fields: [],
            occurred_at: now,
          },
        });
        return { entry_id: args.entry_id };
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new EducationEntryRetiredError(args.entry_id);
      throw err;
    }
  }
}

function manualEntryData(
  id: string,
  tenant_id: string,
  talent_id: string,
  f: EducationEntryFields,
  now: Date,
) {
  return {
    id,
    talent_id,
    tenant_id,
    institution_name: f.institution_name,
    degree_name: f.degree_name,
    field_of_study: f.field_of_study,
    conferred_date: f.conferred_date,
    // Recruiter-entered: no resume excerpt, no source-map refs (they would falsely
    // ground the recruiter's text to resume blocks). The correction chain is the
    // provenance (EducationEntryRetirement + the audit event).
    evidence_text: null,
    source: 'manual' as const,
    source_document_id: null,
    source_refs: [],
    source_map_version: null,
    resume_text_hash: null,
    created_at: now,
  };
}

function compareEntries(
  a: { conferred_date: Date | null; created_at: Date; id: string },
  b: { conferred_date: Date | null; created_at: Date; id: string },
): number {
  const ad = a.conferred_date?.getTime() ?? null;
  const bd = b.conferred_date?.getTime() ?? null;
  if (ad !== bd) {
    if (ad === null) return 1;
    if (bd === null) return -1;
    return bd - ad;
  }
  const c = b.created_at.getTime() - a.created_at.getTime();
  return c !== 0 ? c : a.id.localeCompare(b.id);
}
