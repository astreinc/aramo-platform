import { Injectable, Logger } from '@nestjs/common';
import { AramoError, type VisibilityContextShape } from '@aramo/common';

import { Prisma } from '../../prisma/generated/client/client.js';

import { assertCompensationEditScopes } from './compensation-edit-gate.js';
import { computeDerivedViews } from './compensation-views.js';
import { assertFinancialEditScopes } from './field-group-edit-gate.js';
import { assertStatusOnlyEditScope } from './status-edit-gate.js';
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

// Job-Module §1 Part 1 — translate the create DTO's enterprise + gated
// financial fields into the Prisma create data payload. All nullable /
// defaulted (additive contract). Date strings → Date; decimal strings
// pass through (Prisma coerces). The financial group is write-gated
// upstream by assertFinancialEditScopes (presence-keyed) BEFORE this runs.
function buildEnterpriseCreateData(
  input: CreateRequisitionRequestDto,
): Record<string, unknown> {
  return {
    // Enterprise role-content (un-gated).
    job_type: input.job_type ?? null,
    labor_category: input.labor_category ?? null,
    role_family: input.role_family ?? null,
    seniority_level: input.seniority_level ?? null,
    headcount_reason: input.headcount_reason ?? null,
    work_arrangement: input.work_arrangement ?? null,
    travel_percent: input.travel_percent ?? null,
    relocation_offered: input.relocation_offered ?? false,
    work_authorization: input.work_authorization ?? null,
    end_date: input.end_date === undefined || input.end_date === null ? null : new Date(input.end_date),
    duration_value: input.duration_value ?? null,
    duration_unit: input.duration_unit ?? null,
    extension_possible: input.extension_possible ?? false,
    hours_per_week: input.hours_per_week ?? null,
    source_system: input.source_system ?? null,
    external_req_id: input.external_req_id ?? null,
    imported_at: input.imported_at === undefined || input.imported_at === null ? null : new Date(input.imported_at),
    // Requisition Record Spec Amendment v1.0 — commercial classification +
    // the run-match intent flag (un-gated; additive). run_match_on_create is
    // a stored flag ONLY — it reserves matching, triggers nothing at create.
    rate_type: input.rate_type ?? null,
    allow_subcontractors: input.allow_subcontractors ?? false,
    run_match_on_create: input.run_match_on_create ?? false,
    // Gated financial-planning (🔒 — write-gated upstream).
    target_margin_percent: input.target_margin_percent ?? null,
    markup_percent_target: input.markup_percent_target ?? null,
    rate_card_id: input.rate_card_id ?? null,
    min_bill_rate: input.min_bill_rate ?? null,
    max_bill_rate: input.max_bill_rate ?? null,
    min_pay_rate: input.min_pay_rate ?? null,
    max_pay_rate: input.max_pay_rate ?? null,
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
  // Job-Module §1 Part 1 — enterprise fields.
  job_type: string | null;
  labor_category: string | null;
  role_family: string | null;
  seniority_level: string | null;
  headcount_reason: string | null;
  work_arrangement: string | null;
  travel_percent: number | null;
  relocation_offered: boolean;
  work_authorization: string | null;
  end_date: Date | null;
  duration_value: number | null;
  duration_unit: string | null;
  extension_possible: boolean;
  hours_per_week: number | null;
  source_system: string | null;
  external_req_id: string | null;
  imported_at: Date | null;
  // Requisition Record Spec Amendment v1.0 — commercial classification + flag.
  rate_type: string | null;
  allow_subcontractors: boolean;
  run_match_on_create: boolean;
  // Job-Module §1 Part 1 — gated financial-planning (Decimal money/percent).
  target_margin_percent: Prisma.Decimal | null;
  markup_percent_target: Prisma.Decimal | null;
  rate_card_id: string | null;
  min_bill_rate: Prisma.Decimal | null;
  max_bill_rate: Prisma.Decimal | null;
  min_pay_rate: Prisma.Decimal | null;
  max_pay_rate: Prisma.Decimal | null;
  // SRC-2 R3 — publish surface (UN-gated authored statements).
  public_listing: boolean;
  advertised_pay_min: Prisma.Decimal | null;
  advertised_pay_max: Prisma.Decimal | null;
  advertised_pay_period: RatePeriod | null;
  advertised_pay_currency: string | null;
  // Job-Module LB-2 — the seam.
  golden_profile_id: string | null;
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
    // Job-Module §1 Part 1 — enterprise fields.
    job_type: row.job_type,
    labor_category: row.labor_category,
    role_family: row.role_family,
    seniority_level: row.seniority_level,
    headcount_reason: row.headcount_reason,
    work_arrangement: row.work_arrangement,
    travel_percent: row.travel_percent,
    relocation_offered: row.relocation_offered,
    work_authorization: row.work_authorization,
    end_date: row.end_date === null ? null : row.end_date.toISOString(),
    duration_value: row.duration_value,
    duration_unit: row.duration_unit,
    extension_possible: row.extension_possible,
    hours_per_week: row.hours_per_week,
    source_system: row.source_system,
    external_req_id: row.external_req_id,
    imported_at: row.imported_at === null ? null : row.imported_at.toISOString(),
    // Requisition Record Spec Amendment v1.0 — commercial classification + flag.
    rate_type: row.rate_type,
    allow_subcontractors: row.allow_subcontractors,
    run_match_on_create: row.run_match_on_create,
    // Job-Module §1 Part 1 — gated financial-planning (Decimal → fixed-2
    // string; the interceptor omits these for non-financials-scope actors).
    target_margin_percent: decimalToFixed2(row.target_margin_percent),
    markup_percent_target: decimalToFixed2(row.markup_percent_target),
    rate_card_id: row.rate_card_id,
    min_bill_rate: decimalToFixed2(row.min_bill_rate),
    max_bill_rate: decimalToFixed2(row.max_bill_rate),
    min_pay_rate: decimalToFixed2(row.min_pay_rate),
    max_pay_rate: decimalToFixed2(row.max_pay_rate),
    // SRC-2 R3 — publish surface (UN-gated; never masked, never derived).
    public_listing: row.public_listing,
    advertised_pay_min: decimalToFixed2(row.advertised_pay_min),
    advertised_pay_max: decimalToFixed2(row.advertised_pay_max),
    advertised_pay_period: row.advertised_pay_period,
    advertised_pay_currency: row.advertised_pay_currency,
    // Job-Module LB-2 — the seam (read-only).
    golden_profile_id: row.golden_profile_id,
  };
}

// SRC-2 PR-3 (DEV-E) — the narrow projection returned by
// listPublishableForChannelSync. Only the publish-allowlist columns: the gated
// compensation actuals + financial-planning keys are NEVER selected, so a gated
// value never enters the distribution sweep's memory. D5-by-construction extended
// one layer up from the payload builder into the read itself. Serialized shapes
// (Decimal→fixed-2 string, enum→string, Date→ISO) so the sweep maps 1:1 to
// ChannelPostingInput with no further projectView pass (projectView emits gated
// fields UNMASKED and must never touch a publish egress).
export interface PublishableRequisitionRow {
  id: string;
  tenant_id: string;
  title: string;
  description: string | null;
  city: string | null;
  state_code: string | null;
  job_type: string | null;
  work_arrangement: string | null;
  openings: number;
  advertised_pay_min: string | null;
  advertised_pay_max: string | null;
  advertised_pay_period: string | null;
  advertised_pay_currency: string | null;
  public_listing: boolean;
  updated_at: string;
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
    // Job-Module (LB-4) — the financial-planning write-gate (sibling to the
    // comp gate; own scope requisition:edit:financials). Presence-keyed,
    // 403-before-persist. No-op when the input carries no financial field.
    assertFinancialEditScopes({
      input: input as unknown as Record<string, unknown>,
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
        ...buildEnterpriseCreateData(input),
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
    assertFinancialEditScopes({
      input: input as unknown as Record<string, unknown>,
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
        ...buildEnterpriseCreateData(input),
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
    // PR-A1 Requisition-Gating Rework — the status-only edit gate fires
    // FIRST (BEFORE the comp/financial floors and BEFORE the existence
    // read). The PATCH route no longer carries a route-level
    // @RequireScopes('requisition:edit') guard (RolesGuard is all-or-
    // nothing AND, so it cannot express "edit OR edit:status"); this
    // in-service gate is the authoritative PATCH authorization point:
    //   - requisition:edit holder → unaffected (full edit).
    //   - requisition:edit:status holder (no :edit) → status field ONLY;
    //     any other field → 403.
    //   - neither → 403 (no edit capability).
    assertStatusOnlyEditScope({
      input: args.input as unknown as Record<string, unknown>,
      scopes: args.scopes,
      requestId: args.requestId,
    });
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
    assertFinancialEditScopes({
      input: args.input as unknown as Record<string, unknown>,
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
    // Job-Module §1 Part 1 — enterprise fields (same PATCH semantics:
    // undefined → unchanged; null → cleared; value → set).
    if (i.job_type !== undefined) data['job_type'] = i.job_type;
    if (i.labor_category !== undefined) data['labor_category'] = i.labor_category;
    if (i.role_family !== undefined) data['role_family'] = i.role_family;
    if (i.seniority_level !== undefined) data['seniority_level'] = i.seniority_level;
    if (i.headcount_reason !== undefined) data['headcount_reason'] = i.headcount_reason;
    if (i.work_arrangement !== undefined) data['work_arrangement'] = i.work_arrangement;
    if (i.travel_percent !== undefined) data['travel_percent'] = i.travel_percent;
    if (i.relocation_offered !== undefined) data['relocation_offered'] = i.relocation_offered;
    if (i.work_authorization !== undefined) data['work_authorization'] = i.work_authorization;
    if (i.end_date !== undefined) data['end_date'] = i.end_date === null ? null : new Date(i.end_date);
    if (i.duration_value !== undefined) data['duration_value'] = i.duration_value;
    if (i.duration_unit !== undefined) data['duration_unit'] = i.duration_unit;
    if (i.extension_possible !== undefined) data['extension_possible'] = i.extension_possible;
    if (i.hours_per_week !== undefined) data['hours_per_week'] = i.hours_per_week;
    if (i.source_system !== undefined) data['source_system'] = i.source_system;
    if (i.external_req_id !== undefined) data['external_req_id'] = i.external_req_id;
    if (i.imported_at !== undefined) data['imported_at'] = i.imported_at === null ? null : new Date(i.imported_at);
    // Requisition Record Spec Amendment v1.0 — same PATCH semantics.
    if (i.rate_type !== undefined) data['rate_type'] = i.rate_type;
    if (i.allow_subcontractors !== undefined) data['allow_subcontractors'] = i.allow_subcontractors;
    if (i.run_match_on_create !== undefined) data['run_match_on_create'] = i.run_match_on_create;
    // SRC-2 R3 — publish surface (UN-gated; no assert*EditScopes entry — same
    // PATCH semantics; editable under ordinary requisition:edit).
    if (i.public_listing !== undefined) data['public_listing'] = i.public_listing;
    if (i.advertised_pay_min !== undefined) data['advertised_pay_min'] = i.advertised_pay_min;
    if (i.advertised_pay_max !== undefined) data['advertised_pay_max'] = i.advertised_pay_max;
    if (i.advertised_pay_period !== undefined) data['advertised_pay_period'] = i.advertised_pay_period;
    if (i.advertised_pay_currency !== undefined) data['advertised_pay_currency'] = i.advertised_pay_currency;
    // Job-Module §1 Part 1 — gated financial-planning (write-gated above).
    if (i.target_margin_percent !== undefined) data['target_margin_percent'] = i.target_margin_percent;
    if (i.markup_percent_target !== undefined) data['markup_percent_target'] = i.markup_percent_target;
    if (i.rate_card_id !== undefined) data['rate_card_id'] = i.rate_card_id;
    if (i.min_bill_rate !== undefined) data['min_bill_rate'] = i.min_bill_rate;
    if (i.max_bill_rate !== undefined) data['max_bill_rate'] = i.max_bill_rate;
    if (i.min_pay_rate !== undefined) data['min_pay_rate'] = i.min_pay_rate;
    if (i.max_pay_rate !== undefined) data['max_pay_rate'] = i.max_pay_rate;

    const row = await this.prisma.requisition.update({
      where: { id: args.id },
      data,
    });
    return projectView(row as RequisitionRow);
  }

  // Job-Module LB-2 — stamp the GoldenProfile seam onto the requisition.
  // Tenant-scoped; returns the projected view (golden_profile_id now set).
  // Idempotent at the call site: re-stamping the same id is a harmless
  // overwrite (the confirm flow updates the existing GoldenProfile rather
  // than minting a duplicate — see the AI profile service). Throws 404 if
  // the row is not in tenant.
  async stampGoldenProfileId(args: {
    tenant_id: string;
    id: string;
    golden_profile_id: string;
    requestId: string;
  }): Promise<RequisitionView> {
    const existing = await this.prisma.requisition.findFirst({
      where: { tenant_id: args.tenant_id, id: args.id },
      select: { id: true },
    });
    if (existing === null) {
      throw new AramoError('NOT_FOUND', 'Requisition not found in tenant', 404, {
        requestId: args.requestId,
        details: { id: args.id },
      });
    }
    const row = await this.prisma.requisition.update({
      where: { id: args.id },
      data: { golden_profile_id: args.golden_profile_id },
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
    // Search PR-1 — optional ILIKE-contains quick-search over `title`
    // (trimmed, non-empty when present; the controller gates ?q= on
    // requisition:search). Trigram-accelerated via the pg_trgm GIN index on
    // title. A single-column `title` key (NOT an OR) so it does NOT collide
    // with buildVisibilityWhere's top-level OR — it ANDs as a sibling,
    // narrowing within the A3-OR-D4b visible set.
    q?: string;
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
        ...(args.q === undefined
          ? {}
          : { title: { contains: args.q, mode: 'insensitive' } }),
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

  // SRC-2 PR-3 (DEV-E) — the distribution sweep's publishable read. SYSTEM-class
  // (no actor/visibility filter — the sweep is a tenant-agnostic background job),
  // mirroring findByIdAdmin's admin posture but for a list, filtered to the
  // publishable predicate (status active AND public_listing). The `select` is a
  // strict allowlist: gated comp/financials columns are NOT selected, so they
  // cannot enter the sweep's memory (D5-by-construction). Ordered by updated_at so
  // a large first-tick backlog drains oldest-first; `limit` bounds the batch.
  async listPublishableForChannelSync(args: {
    tenant_id: string;
    limit?: number;
  }): Promise<PublishableRequisitionRow[]> {
    const rows = await this.prisma.requisition.findMany({
      where: {
        tenant_id: args.tenant_id,
        status: 'active',
        public_listing: true,
      },
      select: {
        id: true,
        tenant_id: true,
        title: true,
        description: true,
        city: true,
        state: true,
        job_type: true,
        work_arrangement: true,
        openings: true,
        advertised_pay_min: true,
        advertised_pay_max: true,
        advertised_pay_period: true,
        advertised_pay_currency: true,
        public_listing: true,
        updated_at: true,
      },
      orderBy: { updated_at: 'asc' },
      ...(args.limit === undefined ? {} : { take: args.limit }),
    });
    return rows.map((r) => ({
      id: r.id,
      tenant_id: r.tenant_id,
      title: r.title,
      description: r.description,
      city: r.city,
      state_code: r.state,
      job_type: r.job_type,
      work_arrangement: r.work_arrangement,
      openings: r.openings,
      advertised_pay_min: decimalToFixed2(r.advertised_pay_min),
      advertised_pay_max: decimalToFixed2(r.advertised_pay_max),
      advertised_pay_period: r.advertised_pay_period,
      advertised_pay_currency: r.advertised_pay_currency,
      public_listing: r.public_listing,
      updated_at: r.updated_at.toISOString(),
    }));
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
