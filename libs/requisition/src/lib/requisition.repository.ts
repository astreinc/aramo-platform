import { Injectable, Logger } from '@nestjs/common';
import { AramoError } from '@aramo/common';

import type { CreateRequisitionRequestDto } from './dto/create-requisition-request.dto.js';
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
// The branch is mechanical: see `actorSeesAll(scopes)` — when true,
// drop the assignment predicate; when false, AND in the predicate.

const SCOPE_READ_ALL = 'requisition:read:all';

function actorSeesAll(scopes: readonly string[]): boolean {
  return scopes.includes(SCOPE_READ_ALL);
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
}

function projectView(row: RequisitionRow): RequisitionView {
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
  }): Promise<RequisitionView> {
    const { tenant_id, entered_by_id, input } = args;
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
      },
    });
    return projectView(row as RequisitionRow);
  }

  async update(args: {
    tenant_id: string;
    id: string;
    input: UpdateRequisitionRequestDto;
    requestId: string;
  }): Promise<RequisitionView> {
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
   * Applies the visibility predicate (`actorSeesAll(scopes)`):
   *   - scopes contain `requisition:read:all` → no assignment filter
   *   - scopes contain only `requisition:read` → AND `assignments some
   *     { user_id: actor_user_id }` (Prisma `some` translates to a
   *     correlated EXISTS — the query predicate per Ruling 2).
   */
  async listForActor(args: {
    tenant_id: string;
    actor_scopes: readonly string[];
    actor_user_id: string;
    site_id?: string;
    limit?: number;
  }): Promise<RequisitionView[]> {
    const limit = Math.min(args.limit ?? 50, 200);
    const seesAll = actorSeesAll(args.actor_scopes);
    const rows = await this.prisma.requisition.findMany({
      where: {
        tenant_id: args.tenant_id,
        ...(args.site_id === undefined ? {} : { site_id: args.site_id }),
        ...(seesAll
          ? {}
          : { assignments: { some: { user_id: args.actor_user_id } } }),
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
    actor_scopes: readonly string[];
    actor_user_id: string;
  }): Promise<RequisitionView | null> {
    const seesAll = actorSeesAll(args.actor_scopes);
    const row = await this.prisma.requisition.findFirst({
      where: {
        tenant_id: args.tenant_id,
        id: args.id,
        ...(seesAll
          ? {}
          : { assignments: { some: { user_id: args.actor_user_id } } }),
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
    actor_scopes: readonly string[];
    actor_user_id: string;
    site_id?: string;
  }): Promise<number> {
    const seesAll = actorSeesAll(args.actor_scopes);
    return this.prisma.requisition.count({
      where: {
        tenant_id: args.tenant_id,
        ...(args.site_id === undefined ? {} : { site_id: args.site_id }),
        ...(seesAll
          ? {}
          : { assignments: { some: { user_id: args.actor_user_id } } }),
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
    actor_scopes: readonly string[];
    actor_user_id: string;
    site_id?: string;
  }): Promise<Array<{ status: RequisitionStatus; count: number }>> {
    const seesAll = actorSeesAll(args.actor_scopes);
    const rows = await this.prisma.requisition.groupBy({
      by: ['status'],
      where: {
        tenant_id: args.tenant_id,
        ...(args.site_id === undefined ? {} : { site_id: args.site_id }),
        ...(seesAll
          ? {}
          : { assignments: { some: { user_id: args.actor_user_id } } }),
      },
      _count: { _all: true },
    });
    return rows.map((r) => ({
      status: r.status as RequisitionStatus,
      count: r._count._all,
    }));
  }
}
