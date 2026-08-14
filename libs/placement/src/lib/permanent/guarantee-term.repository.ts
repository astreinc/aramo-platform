import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { AramoError } from '@aramo/common';

import { Prisma } from '../../../prisma/generated/client/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { RemedyPolicy } from '../lifecycle/placement-lifecycle.js';

import type { GuaranteeTermsSourceType } from './guarantee-terms-source.js';
import {
  validateGuaranteeTermPayload,
  validateEffectiveFrom,
  type CreateGuaranteeTermVersionInput,
  type ReviseGuaranteeTermVersionInput,
  type GuaranteeTermVersionView,
  type ResolvedGuaranteeTerms,
} from './guarantee-term-version.js';

// Track 7 / T7-P3 — the reusable, placement-owned, effective-dated guarantee-term-version
// source (directive §3 / §4). Keyed by (tenant_id, requisition_id); NO placement->requisition
// library dependency (requisition_id is a plain UUID axis). Append-only business history
// (§3.8): create inserts an open version, revise first-closes the current open version and
// inserts a successor atomically. resolveEffectiveForActivation returns the single version
// covering an as_of calendar date (fail-closed on ambiguity) for copy-at-activation (§7);
// there is NO live-read after activation.
//
// Outbox event families (§9). Safe payload only: tenant/requisition/version ids, effective
// window, source_type, supersedes id, occurred_at. NEVER exposure amount, source_reference,
// source_version, free text, or PII.
export const OUTBOX_GUARANTEE_TERMS_CREATED = 'permanent_placement.guarantee_terms.created';
export const OUTBOX_GUARANTEE_TERMS_REVISED = 'permanent_placement.guarantee_terms.revised';
export const OUTBOX_GUARANTEE_TERMS_APPLIED = 'permanent_placement.guarantee_terms.applied';

export interface GuaranteeTermVersionRow {
  id: string;
  tenant_id: string;
  requisition_id: string;
  effective_from: Date;
  effective_to: Date | null;
  guarantee_duration_days: number;
  remedy_policy: RemedyPolicy;
  guarantee_exposure_amount: { toFixed: (n: number) => string };
  currency: string;
  source_type: GuaranteeTermsSourceType;
  source_reference: string | null;
  source_version: string | null;
  recorded_by: string;
  recorded_at: Date;
  supersedes_version_id: string | null;
  correlation_id: string | null;
  created_at: Date;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// The SINGLE effective-version resolution (§3.4 / §7). Returns the one version whose
// half-open [effective_from, effective_to) contains the as_of calendar date, or null when
// none is stored. More than one is impossible under the DB EXCLUDE, so it fails closed
// (TERMS_AMBIGUOUS) rather than picking a winner. Shared by the read API and activation.
export async function resolveEffectiveTermRow(
  prisma: PrismaService,
  tenant_id: string,
  requisition_id: string,
  asOf: Date,
  requestId: string,
): Promise<GuaranteeTermVersionRow | null> {
  const rows = (await prisma.permanentPlacementGuaranteeTermVersion.findMany({
    where: {
      tenant_id,
      requisition_id,
      effective_from: { lte: asOf },
      OR: [{ effective_to: null }, { effective_to: { gt: asOf } }],
    },
    orderBy: { effective_from: 'desc' },
    take: 2,
  })) as GuaranteeTermVersionRow[];
  if (rows.length === 0) return null;
  if (rows.length > 1) {
    throw new AramoError('PERMANENT_PLACEMENT_TERMS_AMBIGUOUS', 'more than one guarantee-term version is effective', 500, {
      requestId,
      details: { requisition_id, as_of: isoDate(asOf), reason: 'ambiguous_effective_version' },
    });
  }
  return rows[0] ?? null;
}

// Project a resolved version row into the immutable copy-at-activation shape (§7).
export function resolvedTermsFromRow(row: GuaranteeTermVersionRow): ResolvedGuaranteeTerms {
  return {
    guarantee_term_version_id: row.id,
    guarantee_duration_days: row.guarantee_duration_days,
    remedy_policy: row.remedy_policy,
    guarantee_exposure_amount: row.guarantee_exposure_amount.toFixed(2),
    currency: row.currency,
    source_type: row.source_type,
    source_reference: row.source_reference,
    source_version: row.source_version,
  };
}

@Injectable()
export class GuaranteeTermRepository {
  constructor(private readonly prisma: PrismaService) {}

  // Create the initial (open) guarantee-term version for a (tenant, requisition) (§8 POST).
  // Overlap with an existing open/covering version is rejected fail-closed (TERMS_OVERLAP) by
  // the DB EXCLUDE — use revise to supersede the current version.
  async create(input: CreateGuaranteeTermVersionInput, requestId: string): Promise<GuaranteeTermVersionView> {
    const payload = validateGuaranteeTermPayload(input, requestId);
    const effectiveFrom = validateEffectiveFrom(input.effective_from, requestId);
    const now = new Date();
    const id = uuidv7();

    try {
      const row = await this.prisma.$transaction(async (tx) => {
        const created = (await tx.permanentPlacementGuaranteeTermVersion.create({
          data: {
            id,
            tenant_id: input.tenant_id,
            requisition_id: input.requisition_id,
            effective_from: effectiveFrom,
            effective_to: null,
            guarantee_duration_days: payload.guarantee_duration_days,
            remedy_policy: payload.remedy_policy,
            guarantee_exposure_amount: payload.guarantee_exposure_amount,
            currency: payload.currency,
            source_type: payload.source_type,
            source_reference: payload.source_reference,
            source_version: payload.source_version,
            recorded_by: input.recorded_by,
            recorded_at: now,
            supersedes_version_id: null,
            correlation_id: payload.correlation_id,
          },
        })) as GuaranteeTermVersionRow;
        await this.emitTermsEvent(tx, OUTBOX_GUARANTEE_TERMS_CREATED, created);
        return created;
      });
      return this.projectView(row);
    } catch (e) {
      throw this.translateDbError(e, requestId, { requisition_id: input.requisition_id });
    }
  }

  // Revise the current open version (§8 POST /revise): first-close the predecessor at
  // effective_from and insert the successor [effective_from, NULL) atomically (§3.5 / §6).
  // No backdating; effective_from must be today-or-later and strictly after the predecessor's
  // start. Nothing open to revise -> TERMS_NOT_FOUND.
  async revise(input: ReviseGuaranteeTermVersionInput, requestId: string): Promise<GuaranteeTermVersionView> {
    const payload = validateGuaranteeTermPayload(input, requestId);
    const effectiveFrom = validateEffectiveFrom(input.effective_from, requestId);
    const today = this.todayUtc();
    if (effectiveFrom.getTime() < today.getTime()) {
      throw new AramoError('PERMANENT_PLACEMENT_TERMS_WINDOW_INVALID', 'a guarantee-terms revision may not be backdated', 422, {
        requestId,
        details: { reason: 'revision_backdated', effective_from: input.effective_from },
      });
    }
    const now = new Date();
    const successorId = uuidv7();

    try {
      const row = await this.prisma.$transaction(async (tx) => {
        const predecessor = (await tx.permanentPlacementGuaranteeTermVersion.findFirst({
          where: { tenant_id: input.tenant_id, requisition_id: input.requisition_id, effective_to: null },
          orderBy: { effective_from: 'desc' },
        })) as GuaranteeTermVersionRow | null;
        if (predecessor === null) {
          throw new AramoError('PERMANENT_PLACEMENT_TERMS_NOT_FOUND', 'no current guarantee terms to revise', 404, {
            requestId,
            details: { requisition_id: input.requisition_id, reason: 'no_open_version' },
          });
        }
        if (effectiveFrom.getTime() <= predecessor.effective_from.getTime()) {
          throw new AramoError('PERMANENT_PLACEMENT_TERMS_WINDOW_INVALID', 'a revision must take effect after the current version starts', 422, {
            requestId,
            details: { reason: 'revision_not_after_predecessor', effective_from: input.effective_from },
          });
        }

        // Governed first-close of the predecessor (NULL -> date, once) under the exact marker.
        await tx.$executeRawUnsafe(`SET LOCAL app.guarantee_terms_revision = 'authorized'`);
        await tx.permanentPlacementGuaranteeTermVersion.update({
          where: { id: predecessor.id },
          data: { effective_to: effectiveFrom },
        });

        const successor = (await tx.permanentPlacementGuaranteeTermVersion.create({
          data: {
            id: successorId,
            tenant_id: input.tenant_id,
            requisition_id: input.requisition_id,
            effective_from: effectiveFrom,
            effective_to: null,
            guarantee_duration_days: payload.guarantee_duration_days,
            remedy_policy: payload.remedy_policy,
            guarantee_exposure_amount: payload.guarantee_exposure_amount,
            currency: payload.currency,
            source_type: payload.source_type,
            source_reference: payload.source_reference,
            source_version: payload.source_version,
            recorded_by: input.recorded_by,
            recorded_at: now,
            supersedes_version_id: predecessor.id,
            correlation_id: payload.correlation_id,
          },
        })) as GuaranteeTermVersionRow;
        await this.emitTermsEvent(tx, OUTBOX_GUARANTEE_TERMS_REVISED, successor);
        return successor;
      });
      return this.projectView(row);
    } catch (e) {
      if (e instanceof AramoError) throw e;
      throw this.translateDbError(e, requestId, { requisition_id: input.requisition_id });
    }
  }

  // Full version history for a (tenant, requisition), newest effective_from first (§8 GET).
  async listVersions(tenant_id: string, requisition_id: string): Promise<GuaranteeTermVersionView[]> {
    const rows = (await this.prisma.permanentPlacementGuaranteeTermVersion.findMany({
      where: { tenant_id, requisition_id },
      orderBy: { effective_from: 'desc' },
    })) as GuaranteeTermVersionRow[];
    return rows.map((r) => this.projectView(r));
  }

  // The version effective at an explicit as_of calendar date (§8 GET /effective) — the API
  // read. Returns the view or throws TERMS_NOT_FOUND; ambiguity fails closed (TERMS_AMBIGUOUS).
  async getEffective(tenant_id: string, requisition_id: string, asOf: Date, requestId: string): Promise<GuaranteeTermVersionView> {
    const row = await resolveEffectiveTermRow(this.prisma, tenant_id, requisition_id, asOf, requestId);
    if (row === null) {
      throw new AramoError('PERMANENT_PLACEMENT_TERMS_NOT_FOUND', 'no guarantee terms are effective for the requisition at the given date', 404, {
        requestId,
        details: { requisition_id, as_of: isoDate(asOf), reason: 'no_effective_version' },
      });
    }
    return this.projectView(row);
  }

  // Resolve the single version covering an as_of date for copy-at-activation (§7 / §3.4).
  // Returns null when NO stored version exists (the caller decides the legacy fallback);
  // ambiguity fails closed (TERMS_AMBIGUOUS).
  async resolveEffectiveForActivation(
    tenant_id: string,
    requisition_id: string,
    asOf: Date,
    requestId: string,
  ): Promise<ResolvedGuaranteeTerms | null> {
    const row = await resolveEffectiveTermRow(this.prisma, tenant_id, requisition_id, asOf, requestId);
    if (row === null) return null;
    return resolvedTermsFromRow(row);
  }

  // --- shared helpers ---

  private async emitTermsEvent(
    tx: Prisma.TransactionClient,
    event_type: string,
    row: GuaranteeTermVersionRow,
  ): Promise<void> {
    await tx.outboxEvent.create({
      data: {
        id: uuidv7(),
        tenant_id: row.tenant_id,
        event_type,
        event_payload: {
          tenant_id: row.tenant_id,
          requisition_id: row.requisition_id,
          guarantee_term_version_id: row.id,
          effective_from: isoDate(row.effective_from),
          effective_to: row.effective_to === null ? null : isoDate(row.effective_to),
          source_type: row.source_type,
          supersedes_version_id: row.supersedes_version_id,
          occurred_at: new Date().toISOString(),
        },
      },
    });
  }

  private projectView(row: GuaranteeTermVersionRow): GuaranteeTermVersionView {
    return {
      id: row.id,
      tenant_id: row.tenant_id,
      requisition_id: row.requisition_id,
      effective_from: isoDate(row.effective_from),
      effective_to: row.effective_to === null ? null : isoDate(row.effective_to),
      guarantee_duration_days: row.guarantee_duration_days,
      remedy_policy: row.remedy_policy,
      guarantee_exposure_amount: row.guarantee_exposure_amount.toFixed(2),
      currency: row.currency,
      source_type: row.source_type,
      source_reference: row.source_reference,
      source_version: row.source_version,
      recorded_by: row.recorded_by,
      recorded_at: row.recorded_at.toISOString(),
      supersedes_version_id: row.supersedes_version_id,
      correlation_id: row.correlation_id,
      created_at: row.created_at.toISOString(),
    };
  }

  private todayUtc(): Date {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  }

  // Translate a raw DB constraint violation into a governed AramoError. The overlap EXCLUDE
  // and the effective_from unique index both mean an overlapping/duplicate window
  // (TERMS_OVERLAP); the append-only / immutability trigger means a forbidden historical
  // mutation (TERMS_IMMUTABLE). Anything else is rethrown untranslated.
  private translateDbError(e: unknown, requestId: string, ctx: Record<string, unknown>): AramoError {
    const text = dbErrorText(e);
    if (text.includes('ppgtv_no_window_overlap_excl') || text.includes('ppgtv_tenant_req_from_key')) {
      return new AramoError('PERMANENT_PLACEMENT_TERMS_OVERLAP', 'the guarantee-term effective window overlaps an existing version', 409, {
        requestId,
        details: { ...ctx, reason: 'effective_window_overlap' },
      });
    }
    if (text.includes('is append-only') || text.includes('is immutable')) {
      return new AramoError('PERMANENT_PLACEMENT_TERMS_IMMUTABLE', 'guarantee-term history is immutable', 409, {
        requestId,
        details: { ...ctx, reason: 'immutable_history' },
      });
    }
    if (e instanceof AramoError) return e;
    throw e;
  }
}

// Extract a searchable message from a Prisma7 / PrismaPg error. The driver-adapter cause
// (raw EXCLUDE / trigger check_violation) surfaces in meta, not always in .message — mirror
// the E6 P2002 driver-adapter-shape lesson by stringifying both.
function dbErrorText(e: unknown): string {
  const parts: string[] = [];
  if (e instanceof Error && typeof e.message === 'string') parts.push(e.message);
  const anyE = e as { meta?: unknown };
  try {
    parts.push(JSON.stringify(anyE?.meta ?? {}));
  } catch {
    /* ignore non-serialisable meta */
  }
  return parts.join(' | ');
}
