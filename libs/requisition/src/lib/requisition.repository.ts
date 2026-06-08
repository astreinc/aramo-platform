import { Injectable, Logger } from '@nestjs/common';
import { AramoError, type VisibilityContextShape } from '@aramo/common';

import { Prisma } from '../../prisma/generated/client/client.js';

import { assertCompensationEditScopes } from './compensation-edit-gate.js';
import { computeDerivedViews } from './compensation-views.js';
import type { CreateRequisitionRequestDto } from './dto/create-requisition-request.dto.js';
import type { RatePeriod } from './dto/rate-period.js';
import type { RequisitionCompensationModel } from './dto/requisition-compensation-model.js';
import type { RequisitionView } from './dto/requisition.view.js';
import type { RequisitionStatus } from './dto/requisition-status.js';
import type { UpdateRequisitionRequestDto } from './dto/update-requisition-request.dto.js';
import { PrismaService } from './prisma/prisma.service.js';

// RequisitionRepository — write + read surface for Requisition.
// Reference CRUD (no metering, no event log, no state machine).
//
// === THE VISIBILITY FILTER (directive Ruling 2 — A3's new concept) ===
//
// The filter is a QUERY PREDICATE, not a guard rejection. Both
// `requisition:read` (recruiter) and `requisition:read:all` (tenant_admin)
// pass @RequireScopes('requisition:read') at the RolesGuard layer; the
// difference is WHICH ROWS the repository returns:
//
//   - `requisition:read:all` in AuthContext.scopes → no assignment filter;
//     returns every requisition in tenant (+ site axis).
//   - `requisition:read` only → returns ONLY rows that have a
//     RequisitionAssignment for (requisition_id, AuthContext.sub).
//
// Consequence: a recruiter requesting an UNASSIGNED requisition by id
// returns 404 (not in their visible set), NOT 403 (they have the scope).
// 403 vs 404 matters: the recruiter is authorized to call the route;
// the row is simply outside their visibility set. See the
// findByIdForActor method below.
//
// The branch is mechanical: see `buildVisibilityWhere(visibility)` —
// see_all_requisition drops everything; else the OR-union is AND-ed.
//
// === AUTHZ-D4b — the composed OR-union (the A3 branch PRESERVED) ===
//
// D4b extends the A3 predicate with a SECOND OR arm — D4b client-axis
// visibility (the recruiter sees a req whose CLIENT is in their
// visible_client_ids, regardless of direct req-assignment):
//
//   - `requisition:read:all` → unrestricted (A3 short-circuit, preserved)
//   - else → OR-union:
//       (a) company_id ∈ visibility.visible_client_ids       (D4b NEW)
//       (b) assignments.some.user_id = actor_user_id          (A3 PRESERVED)
//
// The A3 branch is preserved VERBATIM as an OR-arm — a recruiter
// directly assigned to a req STILL sees it even if they're not
// assigned to its client. The new arm extends: a recruiter assigned
// to a CLIENT sees ALL its reqs even without direct assignment.
//
// All 4 read paths (listForActor / findByIdForActor / countForActor /
// countByStatusForActor) apply the same union — list / find / count /
// group-by are consistently scoped so a count cannot leak unseen rows.
//
// The 404-vs-403 contract is preserved: a recruiter whose scope passes
// but whose composed predicate excludes the row gets null → 404, not 403.

// VisibilityContextShape carried as a structural TYPE from @aramo/common
// (the D4b Gate-5 Ruling 1 cycle-avoidance: libs/requisition does NOT
// import @aramo/visibility; the resolved context is passed as a param;
// the import goes the other way — visibility depends on requisition for
// the visible_requisition_ids derived set).

// Build the composed Prisma `where` predicate for the 4 read paths.
// see_all_requisition → no filter (A3's read:all preserved). Else
// returns the OR-union (D4b client + A3 direct). null visible_client_ids
// (see_all_company without read:all — a hypothetical) → no filter
// (every client is visible; the OR collapses to TRUE).
function buildVisibilityWhere(
  visibility: VisibilityContextShape,
): Record<string, unknown> {
  if (visibility.see_all_requisition) return {};
  if (visibility.visible_client_ids === null) return {};
  return {
    OR: [
      { company_id: { in: Array.from(visibility.visible_client_ids) } },
      { assignments: { some: { user_id: visibility.actor_user_id } } },
    ],
  };
}

// Compensation-Field Modeling v1.1 §2 — translate the create DTO's
// optional comp fields into the Prisma create data payload. All
// fields default to null when omitted (existing rows pre-migration
// also surface as null — additive contract). Decimal strings are
// handed off as-is; Prisma's adapter coerces via decimal.js. Returned
// as Record<string, unknown> to spread into the `data` argument.
function buildCompensationCreateData(
  input: CreateRequisitionRequestDto,
): Record<string, unknown> {
  return {
    compensation_model: input.compensation_model ?? null,
    pay_rate_amount: input.pay_rate_amount ?? null,
    pay_rate_currency: input.pay_rate_currency ?? null,
    pay_rate_period: input.pay_rate_period ?? null,
    bill_rate_amount: input.bill_rate_amount ?? null,
    bill_rate_currency: input.bill_rate_currency ?? null,
    bill_rate_period: input.bill_rate_period ?? null,
    placement_fee_percent: input.placement_fee_percent ?? null,
    placement_fee_amount: input.placement_fee_amount ?? null,
    salary_amount: input.salary_amount ?? null,
    salary_currency: input.salary_currency ?? null,
  };
}

interface RequisitionRow {
  id: string;
  tenant_id: string;
  site_id: string | null;
  title: string;
  company_id: string;
  contact_id: string | null;
  company_department_id: string | null;
  status: RequisitionStatus;
  type: string | null;
  duration: string | null;
  rate_max: string | null;
  salary: string | null;
  description: string | null;
  notes: string | null;
  is_hot: boolean;
  openings: number;
  openings_available: number;
  start_date: Date | null;
  city: string | null;
  state: string | null;
  recruiter_id: string | null;
  owner_id: string | null;
  entered_by_id: string | null;
  created_at: Date;
  updated_at: Date;
  // Compensation-Field Modeling v1.1 §2 — structured comp surface.
  // Prisma deserializes Decimal columns to Prisma.Decimal instances;
  // projectView serializes them back to decimal strings for the
  // RequisitionView contract.
  compensation_model: RequisitionCompensationModel | null;
  pay_rate_amount: Prisma.Decimal | null;
  pay_rate_currency: string | null;
  pay_rate_period: RatePeriod | null;
  bill_rate_amount: Prisma.Decimal | null;
  bill_rate_currency: string | null;
  bill_rate_period: RatePeriod | null;
  placement_fee_percent: Prisma.Decimal | null;
  placement_fee_amount: Prisma.Decimal | null;
  salary_amount: Prisma.Decimal | null;
  salary_currency: string | null;
}

// Serialize a Decimal money field to a fixed-2 decimal string. Null
// passes through. v1.1 §10 halt: never coerce to JS number — float
// drift on a 12,2 column would surface as off-by-cent.
function decimalToFixed2(value: Prisma.Decimal | null): string | null {
  return value === null ? null : value.toFixed(2);
}

function projectView(row: RequisitionRow): RequisitionView {
  // v1.1 §2.2 — derived views computed from the two stored facts.
  // The compute is the single canonical site (projectView is THE
  // row→view mapper for every read path: list, get-by-id, create,
  // update, find-admin, find-for-import).
  const derived = computeDerivedViews({
    pay_rate_amount: row.pay_rate_amount,
    pay_rate_currency: row.pay_rate_currency,
    pay_rate_period: row.pay_rate_period,
    bill_rate_amount: row.bill_rate_amount,
    bill_rate_currency: row.bill_rate_currency,
    bill_rate_period: row.bill_rate_period,
  });
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    site_id: row.site_id,
    title: row.title,
    company_id: row.company_id,
    contact_id: row.contact_id,
    company_department_id: row.company_department_id,
    status: row.status,
    type: row.type,
    duration: row.duration,
    rate_max: row.rate_max,
    salary: row.salary,
    description: row.description,
    notes: row.notes,
    is_hot: row.is_hot,
    openings: row.openings,
    openings_available: row.openings_available,
    start_date: row.start_date === null ? null : row.start_date.toISOString(),
    city: row.city,
    state: row.state,
    recruiter_id: row.recruiter_id,
    owner_id: row.owner_id,
    entered_by_id: row.entered_by_id,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
    compensation_model: row.compensation_model,
    pay_rate_amount: decimalToFixed2(row.pay_rate_amount),
    pay_rate_currency: row.pay_rate_currency,
    pay_rate_period: row.pay_rate_period,
    bill_rate_amount: decimalToFixed2(row.bill_rate_amount),
    bill_rate_currency: row.bill_rate_currency,
    bill_rate_period: row.bill_rate_period,
    placement_fee_percent: decimalToFixed2(row.placement_fee_percent),
    placement_fee_amount: decimalToFixed2(row.placement_fee_amount),
    salary_amount: decimalToFixed2(row.salary_amount),
    salary_currency: row.salary_currency,
    margin_amount: derived.margin_amount,
    markup_percent: derived.markup_percent,
    margin_percent: derived.margin_percent,
  };
}

@Injectable()
export class RequisitionRepository {
  private readonly logger = new Logger(RequisitionRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  // -------------------------------------------------------------------------
  // Write path
  // -------------------------------------------------------------------------

  async create(args: {
    tenant_id: string;
    entered_by_id: string;
    input: CreateRequisitionRequestDto;
    // D-AUTHZ-COMP-WRITE-1 — the initiating actor's scopes (the in-service
    // floor). The caller (controller / import service) MUST thread the
    // AuthContext.scopes through; the gate rejects 403 BEFORE any DB write.
    scopes: readonly string[];
    requestId: string;
  }): Promise<RequisitionView> {
    const { tenant_id, entered_by_id, input } = args;
    // D-AUTHZ-COMP-WRITE-1 — the WRITE-side floor. Rejects 403
    // INSUFFICIENT_PERMISSIONS if the caller writes a compensation
    // field-group without the matching compensation:edit:* scope. The
    // gate keys on presence-in-input, NOT on buildCompensationCreateData's
    // null-default writes (which would over-block).
    assertCompensationEditScopes({
      input,
      scopes: args.scopes,
      requestId: args.requestId,
    });
    const row = await this.prisma.requisition.create({
      data: {
        tenant_id,
        site_id: input.site_id ?? null,
        title: input.title,
        company_id: input.company_id,
        contact_id: input.contact_id ?? null,
        company_department_id: input.company_department_id ?? null,
        status: input.status ?? 'active',
        type: input.type ?? null,
        duration: input.duration ?? null,
        rate_max: input.rate_max ?? null,
        salary: input.salary ?? null,
        description: input.description ?? null,
        notes: input.notes ?? null,
        is_hot: input.is_hot ?? false,
        openings: input.openings ?? 1,
        openings_available: input.openings_available ?? input.openings ?? 1,
        start_date: input.start_date === undefined ? null : new Date(input.start_date),
        city: input.city ?? null,
        state: input.state ?? null,
        recruiter_id: input.recruiter_id ?? entered_by_id,
        owner_id: input.owner_id ?? entered_by_id,
        entered_by_id,
        ...buildCompensationCreateData(input),
      },
    });
    return projectView(row as RequisitionRow);
  }

  // PR-A8-1 — import-engine create. Mirrors create(); attributes the row
  // to the import batch for reversion. NO assignment-row insert is done
  // here — imported reqs land WITHOUT recruiter assignments by design
  // (tenant_admin can assign post-import via the existing assign route).
  //
  // D-AUTHZ-COMP-WRITE-1 — the import path is the THIRD write call site
  // (ImportService → here); a controller-only gate would miss it. The
  // initiating actor's scopes (the recruiter who authorized runImport)
  // are threaded from the controller through ImportService to here. The
  // gate fires identically to create() — a recruiter without
  // compensation:edit:pay attempting to import pay fields → 403, the
  // whole row counted as a failure (NOT the silent-pass leak the carry
  // flagged).
  async createForImport(args: {
    tenant_id: string;
    entered_by_id: string;
    import_batch_id: string;
    input: CreateRequisitionRequestDto;
    scopes: readonly string[];
    requestId: string;
  }): Promise<RequisitionView> {
    const { tenant_id, entered_by_id, import_batch_id, input } = args;
    assertCompensationEditScopes({
      input,
      scopes: args.scopes,
      requestId: args.requestId,
    });
    const row = await this.prisma.requisition.create({
      data: {
        tenant_id,
        site_id: input.site_id ?? null,
        title: input.title,
        company_id: input.company_id,
        contact_id: input.contact_id ?? null,
        company_department_id: input.company_department_id ?? null,
        status: input.status ?? 'active',
        type: input.type ?? null,
        duration: input.duration ?? null,
        rate_max: input.rate_max ?? null,
        salary: input.salary ?? null,
        description: input.description ?? null,
        notes: input.notes ?? null,
        is_hot: input.is_hot ?? false,
        openings: input.openings ?? 1,
        openings_available: input.openings_available ?? input.openings ?? 1,
        start_date: input.start_date === undefined ? null : new Date(input.start_date),
        city: input.city ?? null,
        state: input.state ?? null,
        recruiter_id: input.recruiter_id ?? entered_by_id,
        owner_id: input.owner_id ?? entered_by_id,
        entered_by_id,
        import_batch_id,
        ...buildCompensationCreateData(input),
      },
    });
    return projectView(row as RequisitionRow);
  }

  // PR-A8-1 — import-engine reversion. Tenant-scoped deleteMany by the
  // back-reference. Cascade-deletes RequisitionAssignment rows via the
  // intra-schema FK (ON DELETE CASCADE in the schema). Returns the
  // delete count for the audit log.
  async deleteByImportBatch(args: {
    tenant_id: string;
    import_batch_id: string;
  }): Promise<number> {
    const result = await this.prisma.requisition.deleteMany({
      where: {
        tenant_id: args.tenant_id,
        import_batch_id: args.import_batch_id,
      },
    });
    return result.count;
  }

  async update(args: {
    tenant_id: string;
    id: string;
    input: UpdateRequisitionRequestDto;
    // D-AUTHZ-COMP-WRITE-1 — the initiating actor's scopes.
    scopes: readonly string[];
    requestId: string;
  }): Promise<RequisitionView> {
    // D-AUTHZ-COMP-WRITE-1 — fire the WRITE-side floor BEFORE the
    // tenant-existence read so a 403 on a comp-field write does not
    // leak existence-in-tenant information through a 404-vs-403 timing
    // difference. The gate is presence-in-input keyed, NOT what the
    // PATCH spread writes (ruling 4: null-as-clear requires the scope —
    // the input.K !== undefined check captures both set and clear).
    assertCompensationEditScopes({
      input: args.input,
      scopes: args.scopes,
      requestId: args.requestId,
    });
    const existing = await this.prisma.requisition.findFirst({
      where: { tenant_id: args.tenant_id, id: args.id },
      select: { id: true },
    });
    if (existing === null) {
      throw new AramoError(
        'NOT_FOUND',
        'Requisition not found in tenant',
        404,
        { requestId: args.requestId, details: { id: args.id } },
      );
    }
    const data: Record<string, unknown> = {};
    const i = args.input;
    if (i.title !== undefined) data['title'] = i.title;
    if (i.contact_id !== undefined) data['contact_id'] = i.contact_id;
    if (i.company_department_id !== undefined) data['company_department_id'] = i.company_department_id;
    if (i.status !== undefined) data['status'] = i.status;
    if (i.type !== undefined) data['type'] = i.type;
    if (i.duration !== undefined) data['duration'] = i.duration;
    if (i.rate_max !== undefined) data['rate_max'] = i.rate_max;
    if (i.salary !== undefined) data['salary'] = i.salary;
    if (i.description !== undefined) data['description'] = i.description;
    if (i.notes !== undefined) data['notes'] = i.notes;
    if (i.is_hot !== undefined) data['is_hot'] = i.is_hot;
    if (i.openings !== undefined) data['openings'] = i.openings;
    if (i.openings_available !== undefined) data['openings_available'] = i.openings_available;
    if (i.start_date !== undefined) data['start_date'] = i.start_date === null ? null : new Date(i.start_date);
    if (i.city !== undefined) data['city'] = i.city;
    if (i.state !== undefined) data['state'] = i.state;
    if (i.recruiter_id !== undefined) data['recruiter_id'] = i.recruiter_id;
    if (i.owner_id !== undefined) data['owner_id'] = i.owner_id;
    // v1.1 §2 — comp fields. Each follows the same PATCH semantics:
    // undefined → unchanged; null → cleared; string → set (Decimal
    // strings are passed through; Prisma coerces via decimal.js).
    if (i.compensation_model !== undefined) data['compensation_model'] = i.compensation_model;
    if (i.pay_rate_amount !== undefined) data['pay_rate_amount'] = i.pay_rate_amount;
    if (i.pay_rate_currency !== undefined) data['pay_rate_currency'] = i.pay_rate_currency;
    if (i.pay_rate_period !== undefined) data['pay_rate_period'] = i.pay_rate_period;
    if (i.bill_rate_amount !== undefined) data['bill_rate_amount'] = i.bill_rate_amount;
    if (i.bill_rate_currency !== undefined) data['bill_rate_currency'] = i.bill_rate_currency;
    if (i.bill_rate_period !== undefined) data['bill_rate_period'] = i.bill_rate_period;
    if (i.placement_fee_percent !== undefined) data['placement_fee_percent'] = i.placement_fee_percent;
    if (i.placement_fee_amount !== undefined) data['placement_fee_amount'] = i.placement_fee_amount;
    if (i.salary_amount !== undefined) data['salary_amount'] = i.salary_amount;
    if (i.salary_currency !== undefined) data['salary_currency'] = i.salary_currency;

    const row = await this.prisma.requisition.update({
      where: { id: args.id },
      data,
    });
    return projectView(row as RequisitionRow);
  }

  async delete(args: {
    tenant_id: string;
    id: string;
    requestId: string;
  }): Promise<void> {
    const existing = await this.prisma.requisition.findFirst({
      where: { tenant_id: args.tenant_id, id: args.id },
      select: { id: true },
    });
    if (existing === null) {
      throw new AramoError(
        'NOT_FOUND',
        'Requisition not found in tenant',
        404,
        { requestId: args.requestId, details: { id: args.id } },
      );
    }
    await this.prisma.requisition.delete({ where: { id: args.id } });
  }

  // -------------------------------------------------------------------------
  // Read path — THE visibility filter (Ruling 2)
  // -------------------------------------------------------------------------

  /**
   * List requisitions visible to the actor.
   *
   * Applies the composed visibility predicate (A3 + D4b):
   *   - see_all_requisition (requisition:read:all) → no filter
   *   - else → OR-union:
   *       (a) company_id ∈ visibility.visible_client_ids   (D4b client-axis)
   *       (b) assignments.some.user_id = actor_user_id     (A3 direct, preserved)
   *
   * `assignments: { some: ... }` translates to a correlated EXISTS — a
   * query-layer predicate (D6).
   */
  async listForActor(args: {
    tenant_id: string;
    visibility: VisibilityContextShape;
    site_id?: string;
    company_id?: string;
    limit?: number;
  }): Promise<RequisitionView[]> {
    const limit = Math.min(args.limit ?? 50, 200);
    const rows = await this.prisma.requisition.findMany({
      where: {
        tenant_id: args.tenant_id,
        ...(args.site_id === undefined ? {} : { site_id: args.site_id }),
        // Top-level AND with the A3/D4b OR-union below — narrows within
        // visibility. Index-backed by @@index([tenant_id, company_id]).
        ...(args.company_id === undefined ? {} : { company_id: args.company_id }),
        ...buildVisibilityWhere(args.visibility),
      },
      orderBy: { created_at: 'desc' },
      take: limit,
    });
    return (rows as RequisitionRow[]).map(projectView);
  }

  /**
   * Find a requisition by id, applying the visibility filter.
   *
   * Returns null when the row exists in the tenant but is outside the
   * actor's visible set (recruiter without an assignment) — the
   * controller turns null into 404, NOT 403 (per Ruling 2: the scope
   * passes; the row is invisible). Returns null also for genuine
   * not-in-tenant cases; both surface as 404 to the caller.
   */
  async findByIdForActor(args: {
    tenant_id: string;
    id: string;
    visibility: VisibilityContextShape;
  }): Promise<RequisitionView | null> {
    const row = await this.prisma.requisition.findFirst({
      where: {
        tenant_id: args.tenant_id,
        id: args.id,
        ...buildVisibilityWhere(args.visibility),
      },
    });
    return row === null ? null : projectView(row as RequisitionRow);
  }

  /**
   * Tenant-scoped existence check (no visibility filter). Used by the
   * assign/unassign paths — those run under tenant_admin and need to
   * verify a row exists in tenant regardless of any assignment.
   */
  async findByIdAdmin(args: {
    tenant_id: string;
    id: string;
  }): Promise<RequisitionView | null> {
    const row = await this.prisma.requisition.findFirst({
      where: { tenant_id: args.tenant_id, id: args.id },
    });
    return row === null ? null : projectView(row as RequisitionRow);
  }

  // PR-A7 — actor-scoped count for the reporting aggregator. Applies
  // the same A3 visibility predicate as `listForActor`: tenant_admin
  // (scopes include `requisition:read:all`) sees every requisition in
  // tenant; recruiter sees only assigned reqs.
  async countForActor(args: {
    tenant_id: string;
    visibility: VisibilityContextShape;
    site_id?: string;
  }): Promise<number> {
    return this.prisma.requisition.count({
      where: {
        tenant_id: args.tenant_id,
        ...(args.site_id === undefined ? {} : { site_id: args.site_id }),
        ...buildVisibilityWhere(args.visibility),
      },
    });
  }

  // PR-A7 — actor-scoped per-status rollup for the reporting aggregator.
  // Mirrors `countForActor` but groups by the RequisitionStatus enum so
  // the reports endpoint can show a per-status bucket map. Prisma
  // groupBy with where preserves the same A3 predicate (`assignments:
  // { some: ... }`).
  async countByStatusForActor(args: {
    tenant_id: string;
    visibility: VisibilityContextShape;
    site_id?: string;
  }): Promise<Array<{ status: RequisitionStatus; count: number }>> {
    const rows = await this.prisma.requisition.groupBy({
      by: ['status'],
      where: {
        tenant_id: args.tenant_id,
        ...(args.site_id === undefined ? {} : { site_id: args.site_id }),
        ...buildVisibilityWhere(args.visibility),
      },
      _count: { _all: true },
    });
    return rows.map((r) => ({
      status: r.status as RequisitionStatus,
      count: r._count._all,
    }));
  }

  // AUTHZ-D4b — return the SET of requisition IDs visible to the actor
  // under the composed A3 + D4b OR-union. Consumed by
  // VisibilityResolverService to memoize `visible_requisition_ids` for the
  // pipeline / submittal / activity cascade.
  //
  // visible_client_ids === null means see_all_company → the IN-set
  // collapses (no client restriction beyond the A3 OR — caller can also
  // short-circuit via see_all_requisition before invoking).
  async findVisibleRequisitionIds(args: {
    tenant_id: string;
    actor_user_id: string;
    visible_client_ids: ReadonlySet<string> | null;
  }): Promise<string[]> {
    const where: Record<string, unknown> = { tenant_id: args.tenant_id };
    if (args.visible_client_ids !== null) {
      where['OR'] = [
        { company_id: { in: Array.from(args.visible_client_ids) } },
        { assignments: { some: { user_id: args.actor_user_id } } },
      ];
    }
    const rows = await this.prisma.requisition.findMany({
      where,
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }
}
