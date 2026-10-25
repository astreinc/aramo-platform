import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';

import {
  type PlanVersionContent,
  PlanVersionContentError,
  type PlanVersionStatus,
  parsePlanVersionContent,
  planVersionChecksum,
  planVersionContentFromRows,
  planVersionTerms,
} from './plan-version.js';
import { PrismaService } from './prisma/prisma.service.js';

// CCP-A5 (PBD §5.1 row A5; MP-A2 N-15…N-18) — the store for subscription."PlanVersion" and its
// price-version child.
//
// Repository methods ONLY. Publishing and retiring are commercial changes: CCP-A6 calls
// publish / retire / pinProviderPrice when it applies an approved PLAN_VERSION_PUBLISH or
// PLAN_RETIRE change request (CCP-A3 action types; chain Finance → Owner). Nothing in A5 —
// no route, job, seed or deploy step — calls them. There is deliberately NO method that edits a
// PUBLISHED version: a change of terms is a new version (N-16; the DB trigger refuses it anyway).

type Tx = Parameters<Parameters<PrismaService['$transaction']>[0]>[0];
type Db = Tx | PrismaService;

export interface PlanVersionRow {
  id: string;
  plan_id: string;
  version_number: number;
  status: PlanVersionStatus;
  content: unknown;
  content_checksum: string;
  note: string | null;
  created_by: string;
  created_at: Date;
  published_at: Date | null;
  retired_at: Date | null;
}

export class PlanVersionStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanVersionStateError';
  }
}

/** CCP-B2: an exclusive draft was asked for while the plan already holds a DRAFT. */
export class PlanVersionDraftExistsError extends PlanVersionStateError {
  constructor(
    readonly plan_id: string,
    readonly draft_id: string,
  ) {
    super(`plan ${plan_id} already has a DRAFT version (${draft_id})`);
    this.name = 'PlanVersionDraftExistsError';
  }
}

/** The PUBLISHED (current) version of a plan, or null. At most one exists (partial unique index). */
export async function currentPublishedVersion(db: Db, plan_id: string): Promise<PlanVersionRow | null> {
  const row = await db.planVersion.findFirst({ where: { plan_id, status: 'PUBLISHED' } });
  return row as PlanVersionRow | null;
}

const lockSql = (plan_id: string): string => `SELECT pg_advisory_xact_lock(hashtextextended('subscription.plan_version:${plan_id}', 0))`;

@Injectable()
export class PlanVersionRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Newest first. */
  async listVersions(plan_id: string): Promise<PlanVersionRow[]> {
    return (await this.prisma.planVersion.findMany({ where: { plan_id }, orderBy: { version_number: 'desc' } })) as PlanVersionRow[];
  }

  /** One version with its terms checksum-verified and parsed (fail closed). */
  async getVersion(id: string): Promise<{ row: PlanVersionRow; terms: PlanVersionContent } | null> {
    const row = (await this.prisma.planVersion.findUnique({ where: { id } })) as PlanVersionRow | null;
    if (row === null) return null;
    return { row, terms: planVersionTerms(row) };
  }

  async currentVersion(plan_id: string): Promise<PlanVersionRow | null> {
    return currentPublishedVersion(this.prisma, plan_id);
  }

  /** The format-1 content of the plan's LIVE rows (what a v1 or a fresh draft starts from). */
  async liveContent(plan_id: string, db: Db = this.prisma): Promise<PlanVersionContent> {
    const plan = await db.plan.findUnique({ where: { id: plan_id }, include: { allowances: true, allowance_windows: true, capacities: true, features: true } });
    if (plan === null) throw new PlanVersionStateError(`unknown plan ${plan_id}`);
    return planVersionContentFromRows({
      plan,
      allowances: plan.allowances,
      allowance_windows: plan.allowance_windows,
      capacities: plan.capacities,
      features: plan.features,
    });
  }

  /**
   * Appends a DRAFT with the next version number (under a per-plan advisory lock). CCP-B2:
   * `exclusive` refuses (PlanVersionDraftExistsError) when the plan already holds a DRAFT,
   * checked under the same lock; `db` runs inside the caller's transaction (its audit row
   * commits or rolls back with the draft).
   */
  async createDraft(
    input: { plan_id: string; content: PlanVersionContent; created_by: string; note?: string | null; at?: Date; exclusive?: boolean },
    db?: Tx,
  ): Promise<PlanVersionRow> {
    const content = parsePlanVersionContent(input.content);
    const run = async (tx: Tx): Promise<PlanVersionRow> => {
      await tx.$executeRawUnsafe(lockSql(input.plan_id));
      if (input.exclusive === true) {
        const draft = await tx.planVersion.findFirst({ where: { plan_id: input.plan_id, status: 'DRAFT' }, select: { id: true } });
        if (draft !== null) throw new PlanVersionDraftExistsError(input.plan_id, draft.id);
      }
      const latest = await tx.planVersion.aggregate({ where: { plan_id: input.plan_id }, _max: { version_number: true } });
      return (await tx.planVersion.create({
        data: {
          id: uuidv7(),
          plan_id: input.plan_id,
          version_number: (latest._max.version_number ?? 0) + 1,
          status: 'DRAFT',
          content: content as object,
          content_checksum: planVersionChecksum(content),
          note: input.note ?? null,
          created_by: input.created_by,
          created_at: input.at ?? new Date(),
        },
      })) as PlanVersionRow;
    };
    return db !== undefined ? run(db) : this.prisma.$transaction(run);
  }

  /** A DRAFT copied from the plan's live rows. */
  async createDraftFromLive(input: { plan_id: string; created_by: string; note?: string | null; at?: Date }): Promise<PlanVersionRow> {
    return this.createDraft({ ...input, content: await this.liveContent(input.plan_id) });
  }

  /** Replace a DRAFT's content. A PUBLISHED or RETIRED version is never edited. CCP-B2: `db` = the caller's transaction. */
  async updateDraft(id: string, content: PlanVersionContent, note?: string | null, db?: Tx): Promise<PlanVersionRow> {
    const parsed = parsePlanVersionContent(content);
    const run = async (tx: Tx): Promise<PlanVersionRow> => {
      const row = await tx.planVersion.findUnique({ where: { id } });
      if (row === null) throw new PlanVersionStateError(`unknown plan version ${id}`);
      if (row.status !== 'DRAFT') throw new PlanVersionStateError(`plan version ${id} is ${row.status}: only a DRAFT is edited; a change of terms is a new version`);
      return (await tx.planVersion.update({
        where: { id },
        data: { content: parsed as object, content_checksum: planVersionChecksum(parsed), ...(note !== undefined ? { note } : {}) },
      })) as PlanVersionRow;
    };
    return db !== undefined ? run(db) : this.prisma.$transaction(run);
  }

  /**
   * DRAFT → PUBLISHED; the plan's previous PUBLISHED version (if any) → RETIRED in the same
   * transaction. Existing subscriptions keep their pin (grandfathering, N-18). CCP-A6 calls this
   * when it applies an approved PLAN_VERSION_PUBLISH change request; A5 never does.
   */
  async publish(id: string, at: Date = new Date(), db?: Tx): Promise<PlanVersionRow> {
    const run = async (tx: Tx): Promise<PlanVersionRow> => {
      const row = await tx.planVersion.findUnique({ where: { id } });
      if (row === null) throw new PlanVersionStateError(`unknown plan version ${id}`);
      await tx.$executeRawUnsafe(lockSql(row.plan_id));
      if (row.status !== 'DRAFT') throw new PlanVersionStateError(`plan version ${id} is ${row.status}, not DRAFT`);
      planVersionTerms(row);
      await tx.planVersion.updateMany({ where: { plan_id: row.plan_id, status: 'PUBLISHED' }, data: { status: 'RETIRED', retired_at: at } });
      return (await tx.planVersion.update({ where: { id }, data: { status: 'PUBLISHED', published_at: at } })) as PlanVersionRow;
    };
    return db !== undefined ? run(db) : this.prisma.$transaction(run);
  }

  /** PUBLISHED → RETIRED (no longer sold; grandfathered subscriptions keep it). A6 / PLAN_RETIRE. */
  async retire(id: string, at: Date = new Date(), db?: Tx): Promise<PlanVersionRow> {
    const run = async (tx: Tx): Promise<PlanVersionRow> => {
      const row = await tx.planVersion.findUnique({ where: { id } });
      if (row === null) throw new PlanVersionStateError(`unknown plan version ${id}`);
      if (row.status !== 'PUBLISHED') throw new PlanVersionStateError(`plan version ${id} is ${row.status}, not PUBLISHED`);
      return (await tx.planVersion.update({ where: { id }, data: { status: 'RETIRED', retired_at: at } })) as PlanVersionRow;
    };
    return db !== undefined ? run(db) : this.prisma.$transaction(run);
  }

  /**
   * D3 — pin a provider price to a version, once (DRAFT or PUBLISHED; never RETIRED). An
   * existing pin is never changed: a different price is a new version. Re-pinning the SAME
   * price is idempotent. Applied by A6 (incl. the v1 cutover pins); A5 never calls it.
   */
  async pinProviderPrice(input: { plan_version_id: string; provider: 'STRIPE'; provider_price_ref: string; created_by: string; at?: Date }): Promise<{ created: boolean }> {
    const ref = input.provider_price_ref.trim();
    if (ref === '') throw new PlanVersionContentError('provider_price_ref must be non-empty');
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.planVersionPrice.findUnique({ where: { plan_version_id_provider: { plan_version_id: input.plan_version_id, provider: input.provider } } });
      if (existing !== null) {
        if (existing.provider_price_ref !== ref) throw new PlanVersionStateError(`plan version ${input.plan_version_id} is already pinned to another ${input.provider} price`);
        return { created: false };
      }
      await tx.planVersionPrice.create({
        data: { id: uuidv7(), plan_version_id: input.plan_version_id, provider: input.provider, provider_price_ref: ref, created_by: input.created_by, created_at: input.at ?? new Date() },
      });
      return { created: true };
    });
  }
}
