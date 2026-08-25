import { Injectable, Logger } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { AramoError, type VisibilityContextShape } from '@aramo/common';
import {
  insertPolicyDecisionRecordInTx,
  type InsertPolicyDecisionRecordInput,
} from '@aramo/policy-store';
// Track 4 / T4-B2 — capacity truth is DERIVED from the placement-owned ACTIVE
// ContractAssignment population, PULLED via the declared requisition->placement
// edge (§4). The stored openings_available column is no longer the reader source
// (migrated here); it is dropped in the dedicated column-drop migration.
import { CapacityProjectionRepository, deriveCapacity } from '@aramo/placement';
// L8-B2 — requisition-grain Client Status reader, hard-imported + DI-injected
// following the CapacityProjectionRepository precedent (Correction A). Read-only.
import { RequisitionSubmittalEligibilityReader } from '@aramo/submittal-eligibility';

import { Prisma } from '../../prisma/generated/client/client.js';

import { SetPriorityPolicyService } from './policy/set-priority-policy.service.js';
import { RequisitionTransitionPolicyService } from './policy/requisition-transition-policy.service.js';
import { assertCompensationEditScopes } from './compensation-edit-gate.js';
import { computeDerivedViews } from './compensation-views.js';
import { assertFinancialEditScopes } from './field-group-edit-gate.js';
import { assertStatusOnlyEditScope } from './status-edit-gate.js';
import { assertApprovalAuthorization } from './approval-authorization-gate.js';
import {
  assertEstablishmentAuthorization,
  type CreationMode,
} from './establishment-authorization-gate.js';
import type { CreateRequisitionRequestDto } from './dto/create-requisition-request.dto.js';
import type { RatePeriod } from './dto/rate-period.js';
import type { RequisitionCompensationModel } from './dto/requisition-compensation-model.js';
import type { RequisitionView } from './dto/requisition.view.js';
import { isGatedRecruitingStatus, type RecruitingStatus } from './dto/requisition-status.js';
import { governingAction } from './dto/requisition-transitions.js';
import type { UpdateRequisitionRequestDto } from './dto/update-requisition-request.dto.js';
import type { RecordRequisitionLifecycleEventInput } from './requisition-lifecycle-event.store.js';
import { PrismaService } from './prisma/prisma.service.js';
import {
  assertExternalIdentityCoPresence,
  canonicalizeSourceSystem,
  resolveExternalIdentity,
  validateExternalReqId,
} from './external-identity-validation.js';

// T8-P1 — a write that collides on the external-identity partial-unique index
// (Requisition_external_identity_key) surfaces a Prisma P2002 naming THAT index
// specifically. Deliberately narrow (mirrors E6's isLiveEpisodeIndexViolation):
// an arbitrary uniqueness violation must NOT be swallowed as an identity
// conflict — it is translated to the exact-name 409, never a generic P2002.
const EXTERNAL_IDENTITY_INDEX = 'Requisition_external_identity_key';
const EXTERNAL_IDENTITY_FIELDS = ['tenant_id', 'source_system', 'external_req_id'];
function isExternalIdentityIndexViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as {
    code?: unknown;
    meta?: {
      target?: unknown;
      driverAdapterError?: {
        cause?: { originalMessage?: unknown; constraint?: { fields?: unknown } };
      };
    };
    message?: unknown;
  };
  if (e.code !== 'P2002') return false;
  // Prisma <7 / non-adapter: meta.target names the index.
  const target = e.meta?.target;
  if (
    (typeof target === 'string' && target.includes(EXTERNAL_IDENTITY_INDEX)) ||
    (Array.isArray(target) &&
      target.some((t) => typeof t === 'string' && t.includes(EXTERNAL_IDENTITY_INDEX)))
  ) {
    return true;
  }
  // Prisma 7 driver-adapter (PrismaPg): the violated constraint's name is in the
  // cause's originalMessage; the columns are the exact external-identity triple.
  // Keyed on the index name (never a generic P2002) with the field set as a
  // corroborating cross-check.
  const cause = e.meta?.driverAdapterError?.cause;
  if (cause) {
    if (
      typeof cause.originalMessage === 'string' &&
      cause.originalMessage.includes(EXTERNAL_IDENTITY_INDEX)
    ) {
      return true;
    }
    const fields = cause.constraint?.fields;
    if (
      Array.isArray(fields) &&
      fields.length === EXTERNAL_IDENTITY_FIELDS.length &&
      EXTERNAL_IDENTITY_FIELDS.every((f) => fields.includes(f))
    ) {
      return true;
    }
  }
  // Fallback: the index name anywhere in the rendered message.
  return typeof e.message === 'string' && e.message.includes(EXTERNAL_IDENTITY_INDEX);
}

// Build the typed 409 for an external-identity collision (T8-P1 REJECT contract).
function externalIdentityConflict(requestId: string): AramoError {
  return new AramoError(
    'REQUISITION_EXTERNAL_IDENTITY_CONFLICT',
    'A requisition with this external identity (source_system + external_req_id) already exists for this tenant',
    409,
    { requestId },
  );
}

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
  requestId: string,
): Record<string, unknown> {
  // T8-P1 — canonicalize + validate the (source_system, external_req_id)
  // external identity BEFORE persist. Storing the CANONICAL source_system is
  // load-bearing: the partial-unique index keys on the stored value, so
  // normalization is what makes 'Fieldglass' and 'fieldglass' one identity.
  const identity = resolveExternalIdentity(input, requestId);
  return {
    // Enterprise role-content (un-gated).
    job_type: input.job_type ?? null,
    labor_category: input.labor_category ?? null,
    role_family: input.role_family ?? null,
    seniority_level: input.seniority_level ?? null,
    headcount_reason: input.headcount_reason ?? null,
    work_arrangement: input.work_arrangement ?? null,
    // PR-17 — hybrid onsite frequency. Mapped as-is; the null-unless-hybrid +
    // 1-4 invariant is asserted in create/createForImport BEFORE this runs.
    onsite_days_per_week: input.onsite_days_per_week ?? null,
    travel_percent: input.travel_percent ?? null,
    relocation_offered: input.relocation_offered ?? false,
    work_authorization: input.work_authorization ?? null,
    end_date: input.end_date === undefined || input.end_date === null ? null : new Date(input.end_date),
    duration_value: input.duration_value ?? null,
    duration_unit: input.duration_unit ?? null,
    extension_possible: input.extension_possible ?? false,
    hours_per_week: input.hours_per_week ?? null,
    source_system: identity.source_system,
    external_req_id: identity.external_req_id,
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

// PR-17 — the server-side floor for onsite_days_per_week (directive: "Enforced
// server-side, not by the form"). onsite frequency is meaningful ONLY for a
// hybrid work arrangement and only in 1-4; 0 (remote) and 5 (onsite) are
// work_arrangement values, not frequencies. Null is always acceptable — an
// unknown hybrid frequency, or any non-hybrid arrangement. Throws
// VALIDATION_ERROR (400); returns void when acceptable. `work_arrangement` is
// the EFFECTIVE arrangement (post-update on the update path).
function assertOnsiteDaysPerWeekValid(args: {
  work_arrangement: string | null;
  value: number | null;
  requestId: string;
}): void {
  if (args.value === null) return;
  if (args.work_arrangement !== 'hybrid') {
    throw new AramoError(
      'VALIDATION_ERROR',
      'onsite_days_per_week is only valid when work_arrangement is hybrid',
      400,
      {
        requestId: args.requestId,
        details: { field: 'onsite_days_per_week', reason: 'not_hybrid' },
      },
    );
  }
  if (!Number.isInteger(args.value) || args.value < 1 || args.value > 4) {
    throw new AramoError(
      'VALIDATION_ERROR',
      'onsite_days_per_week must be a whole number between 1 and 4',
      400,
      {
        requestId: args.requestId,
        details: { field: 'onsite_days_per_week', reason: 'out_of_range' },
      },
    );
  }
}

interface RequisitionRow {
  id: string;
  tenant_id: string;
  site_id: string | null;
  title: string;
  requisition_number: number;
  company_id: string;
  contact_id: string | null;
  company_department_id: string | null;
  status: RecruitingStatus;
  type: string | null;
  duration: string | null;
  description: string | null;
  notes: string | null;
  is_hot: boolean;
  openings: number;
  // T4-B2 §6 — stored openings_available RETIRED. Availability is derived
  // (max(openings - active ContractAssignment count, 0)); the row no longer carries
  // a physical column, and projectView receives the derived value as a parameter.
  start_date: Date | null;
  city: string | null;
  state: string | null;
  recruiter_id: string | null;
  owner_id: string | null;
  entered_by_id: string | null;
  created_at: Date;
  updated_at: Date;
  // Track 1 T1-b — the optimistic-concurrency token. Present on every full-row
  // read (create/list/get/casUpdate all read the whole row); T1-e projects it
  // onto the view (§2.1) so a caller can read-then-write.
  version: number;
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
  onsite_days_per_week: number | null;
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

// Track 4 / T4-B2 — openings_available is now supplied by the caller as the DERIVED
// value (max(capacity_balance,0) from the placement projection), NOT read from the
// stored column. projectView stays a pure sync mapper; the async capacity pull is
// the caller's (projectViewWithCapacity for single rows; the batch path for lists).
function projectView(
  row: RequisitionRow,
  openings_available: number,
  capacity_balance: number,
): RequisitionView {
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
    requisition_number: row.requisition_number,
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
    // T4-B2 — the DERIVED available-openings value (caller-supplied), no longer the
    // stored column. The response field survives; its authority is now placement.
    openings_available,
    // Capacity-visibility — the SIGNED balance (caller-supplied), UNclamped so
    // Over capacity (< 0) is distinguishable from Fully consumed (== 0).
    capacity_balance,
    // L8-B2 — default null (⇒ OPEN in the UI, R-DEFAULT-OPEN). The list/detail read
    // paths enrich these from the SubmittalEligibility reader; a reader miss or error
    // stays null (fail-soft — never break the read).
    client_submittal_status: null,
    client_submittal_reason: null,
    start_date: row.start_date === null ? null : row.start_date.toISOString(),
    city: row.city,
    state: row.state,
    recruiter_id: row.recruiter_id,
    owner_id: row.owner_id,
    entered_by_id: row.entered_by_id,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
    // T1-e §2.1 — surface the concurrency token so read-then-write is possible.
    version: row.version,
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
    onsite_days_per_week: row.onsite_days_per_week,
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
    // PR-14 — personal bookmark state. False by default here; the
    // actor-scoped read paths (listForActor / findByIdForActor) enrich it
    // per calling user. projectView has no actor context, so it cannot
    // resolve this on its own.
    bookmarked: false,
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

// T1-c — pre-governance lifecycle reason codes. These events carry a NULL
// policy_decision_id (no policy decision governs them yet); the null id — not
// the reason_code — is §D17c's canonical "ungoverned" marker. T1-e's governed
// transitions supersede these with the policy's own reason_code. reason_code is
// NOT NULL, so a value is always required; these name the mechanical operation.
const LIFECYCLE_REASON_CREATED = 'REQUISITION_CREATED';
const LIFECYCLE_REASON_IMPORTED = 'REQUISITION_IMPORTED';
const LIFECYCLE_REASON_STATUS_CHANGED = 'STATUS_CHANGED';
// L1-A (Directive §6) — a governed non-draft establishment (MANUAL-ESTABLISH
// or SYSTEM) is recorded with a distinct free-text reason_code so the audit
// trail distinguishes an ordinary manual draft (REQUISITION_CREATED) from a
// deliberate initial-state establishment. No schema change (reason_code is
// free text). Integration imports keep REQUISITION_IMPORTED.
const LIFECYCLE_REASON_ESTABLISHED = 'REQUISITION_ESTABLISHED';

@Injectable()
export class RequisitionRepository {
  private readonly logger = new Logger(RequisitionRepository.name);

  constructor(
    private readonly prisma: PrismaService,
    // ADR-0024 PR-7 (R1) — SET_PRIORITY gate at the repository floor
    // (D-AUTHZ-COMP-WRITE-1: the deepest layer all write paths traverse).
    private readonly setPriorityPolicy: SetPriorityPolicyService,
    // T1-e (§2.2) — the governed-transition gate, same repository floor. A
    // status-changing update routes through it (R8 — no direct-set bypass).
    private readonly transitionPolicy: RequisitionTransitionPolicyService,
    // Track 4 / T4-B2 — the placement-owned capacity projection. projectView is
    // THE single canonical row->view mapper; the reader cutover routes its
    // openings_available through this pull (derived truth), never the stored
    // column. Trailing param (ctor-ripple contained). PlacementCapacityModule is
    // already imported by RequisitionModule (B1), so injection needs no new wiring.
    private readonly capacity: CapacityProjectionRepository,
    // L8-B2 — authoritative requisition-grain Client Status reader (SubmittalEligibility
    // truth). Trailing param (ctor-ripple contained). SubmittalEligibilityModule is
    // imported by RequisitionModule, so injection needs no further wiring.
    private readonly clientStatus: RequisitionSubmittalEligibilityReader,
  ) {}

  // Track 4 / T4-B2 — project ONE row to a view with the DERIVED openings_available
  // pulled from placement (ACTIVE ContractAssignment count). The single-row read
  // path (create/import/update/stamp/get/admin-get). List uses the batch variant.
  private async projectViewWithCapacity(
    tenant_id: string,
    row: RequisitionRow,
  ): Promise<RequisitionView> {
    const { openings_available, capacity_balance } =
      await this.capacity.projectCapacity(tenant_id, row.id, row.openings);
    const view = projectView(row, openings_available, capacity_balance);
    // L8-B2 — every single-row response (get / create / update / import / stamp) carries
    // authoritative Client Status, consistent with the list. Fail-soft (R-DEFAULT-OPEN).
    const [enriched] = await this.enrichClientStatus(tenant_id, [view]);
    return enriched ?? view;
  }

  // T1-c — emit ONE lifecycle event inside the caller's transaction. The event
  // row commits IFF the mutation commits (R3, fail-closed): `tx` is the SAME
  // requisition Prisma client the status change runs on, so
  // requisitionLifecycleEvent.create shares its transaction — no cross-schema
  // raw SQL (contrast insertPolicyDecisionRecordInTx, which is raw ONLY because
  // it writes policy_store's client). This is the sole lifecycle write path
  // wired from the domain; it appends, never updates or deletes (§D17c).
  private async recordLifecycleEventInTx(
    tx: Prisma.TransactionClient,
    input: RecordRequisitionLifecycleEventInput,
  ): Promise<void> {
    await tx.requisitionLifecycleEvent.create({
      data: {
        id: uuidv7(),
        tenant_id: input.tenant_id,
        requisition_id: input.requisition_id,
        previous_status: input.previous_status,
        next_status: input.next_status,
        actor_id: input.actor_id,
        origin: input.origin,
        reason_code: input.reason_code,
        policy_decision_id: input.policy_decision_id ?? null,
        correlation_id: input.correlation_id,
      },
    });
  }

  // PR-15 — allocate the next per-tenant requisition_number INSIDE the create
  // transaction. A single atomic statement: the ON CONFLICT path row-locks
  // RequisitionNumberSequence for this tenant, increments, and returns — so two
  // racing creates serialise on that one row and receive DISTINCT numbers, with
  // no held-open window (the reason this is preferred over SELECT … FOR UPDATE).
  // A brand-new tenant has no row; the INSERT seeds it at 1000 (first REQ-1000).
  // next_value stores the LAST number handed out. `tx` shares the caller's
  // transaction, so a rollback of the create rolls back the allocation too
  // (a burned number would only ever be a gap, which is allowed — never reused).
  private async allocateRequisitionNumberInTx(
    tx: Prisma.TransactionClient,
    tenantId: string,
  ): Promise<number> {
    const rows = await tx.$queryRaw<Array<{ next_value: number }>>`
      INSERT INTO "requisition"."RequisitionNumberSequence" ("tenant_id", "next_value")
      VALUES (${tenantId}::uuid, 1000)
      ON CONFLICT ("tenant_id") DO UPDATE
        SET "next_value" = "requisition"."RequisitionNumberSequence"."next_value" + 1
      RETURNING "next_value"
    `;
    return rows[0]!.next_value;
  }

  // PR-7 — the REQUISITION · SET_PRIORITY gate. Called ONLY when is_hot is being
  // set TRUE (R3 — clearing is_hot is cleanup, never governed; "false" is not a
  // rule). Returns the §D17a provenance to persist in the write transaction, or
  // null when not governed. `enforce` (create/update): a DENY records the refusal
  // standalone and throws 403 POLICY_DENIED. Import passes enforce=false — it
  // RECORDS the decision (so the exemption is visible) but proceeds regardless
  // (R2: import is a bulk historical load, not the operation the matrix governs).
  private async gateSetPriority(args: {
    tenant_id: string;
    status: string;
    scopes: readonly string[];
    actor_id: string;
    requestId: string;
    enforce: boolean;
    is_hot?: boolean;
  }): Promise<InsertPolicyDecisionRecordInput | null> {
    if (args.is_hot !== true) return null; // R3 — only ASSERTING priority is governed
    const outcome = await this.setPriorityPolicy.decide({
      tenant_id: args.tenant_id,
      status: args.status,
      scopes: args.scopes,
      actor_id: args.actor_id,
      origin: 'ui',
      correlation_id: args.requestId,
    });
    if (args.enforce && outcome.disposition === 'DENY') {
      // No mutation. Record the refusal standalone (provenance may exist without
      // a mutation), refuse with the reason_code ONLY.
      await this.prisma.$transaction((tx) =>
        insertPolicyDecisionRecordInTx(tx, outcome.provenance),
      );
      throw new AramoError(
        'POLICY_DENIED',
        'The requisition lifecycle policy denied this priority change',
        403,
        { requestId: args.requestId, details: { reason_code: outcome.reason_code } },
      );
    }
    return outcome.provenance;
  }

  // T1-e (§2.2 / R8) — the governed-transition gate. Called when a PATCH
  // CHANGES status. Resolves the governing action from the (from, to) EDGE
  // (Amendment B — APPROVE and REOPEN converge on `open`, disambiguated by the
  // from-status); if the edge has no governing action (submittals_closed / lead
  // / ordinary entry into draft — the R8 boundary ruling) the change is an
  // ORDINARY edit and this returns null (no policy, no decision record). For a
  // governed transition it evaluates the declared FROM status: on DENY it
  // records the refusal standalone (§D17a) and throws POLICY_DENIED (reason
  // code ONLY — never leak rule_id/version); on ALLOW it returns the provenance
  // to persist in the write tx PLUS a caller-controlled decision id to thread
  // into the lifecycle event (§2.2). Mirrors gateSetPriority.
  private async gateTransition(args: {
    tenant_id: string;
    id: string;
    from_status: RecruitingStatus;
    to_status: RecruitingStatus;
    scopes: readonly string[];
    actor_id: string;
    requestId: string;
  }): Promise<{ provenance: InsertPolicyDecisionRecordInput; decision_id: string } | null> {
    const action = governingAction(args.from_status, args.to_status);
    if (action === null) return null; // ungoverned ordinary edit (R8 boundary)
    // Approval sub-workflow (Amendment B, R-RBAC) — per-edge authorization for the
    // approval-DECISION edges (APPROVE / REJECT), BEFORE the policy engine and any
    // write. APPROVE resolves the submitter (the actor of the most recent
    // SUBMIT_FOR_APPROVAL) so segregation of duties can refuse self-approval.
    const submitterId =
      action === 'APPROVE'
        ? await this.latestApprovalSubmitterActor(args.tenant_id, args.id)
        : null;
    assertApprovalAuthorization({
      action,
      scopes: args.scopes,
      actorId: args.actor_id,
      submitterId,
      requestId: args.requestId,
    });
    const outcome = await this.transitionPolicy.decide({
      tenant_id: args.tenant_id,
      action,
      from_status: args.from_status,
      scopes: args.scopes,
      actor_id: args.actor_id,
      origin: 'ui',
      correlation_id: args.requestId,
    });
    if (outcome.disposition === 'DENY') {
      // No mutation. Record the refusal standalone (provenance may exist without
      // a mutation), refuse with the reason_code ONLY.
      await this.prisma.$transaction((tx) =>
        insertPolicyDecisionRecordInTx(tx, outcome.provenance),
      );
      throw new AramoError(
        'POLICY_DENIED',
        'The requisition lifecycle policy denied this transition',
        403,
        { requestId: args.requestId, details: { reason_code: outcome.reason_code } },
      );
    }
    return { provenance: outcome.provenance, decision_id: uuidv7() };
  }

  // Approval sub-workflow (Amendment B) — the actor who last moved this
  // requisition INTO pending_approval (the SUBMIT_FOR_APPROVAL). The lifecycle
  // event history is the record of WHO submitted; the most recent event with
  // next_status='pending_approval' names the current submitter. Returns null when
  // no such event exists (defensive — the SoD check then no-ops but the
  // requisition:approve scope requirement still stands).
  private async latestApprovalSubmitterActor(
    tenant_id: string,
    requisition_id: string,
  ): Promise<string | null> {
    const ev = await this.prisma.requisitionLifecycleEvent.findFirst({
      where: { tenant_id, requisition_id, next_status: 'pending_approval' },
      orderBy: { occurred_at: 'desc' },
      select: { actor_id: true },
    });
    return ev?.actor_id ?? null;
  }

  // T1-e — persist the §D17a transition provenance with a CALLER-CONTROLLED id
  // so the SAME id lands in RequisitionLifecycleEvent.policy_decision_id (§2.2).
  // This mirrors @aramo/policy-store's insertPolicyDecisionRecordInTx byte-for-
  // byte EXCEPT the id is supplied rather than generated internally: that helper
  // generates its id and never returns it, and §5 prohibits changing policy-
  // store to add an id parameter — so the insert is duplicated here (the sole
  // divergence). Runs on the caller's tx client, so the record commits IFF the
  // transition commits (a stale-version CAS abort writes neither — R4).
  private async insertTransitionDecisionRecordInTx(
    tx: Prisma.TransactionClient,
    id: string,
    input: InsertPolicyDecisionRecordInput,
  ): Promise<void> {
    const inputsJson = JSON.stringify(input.inputs);
    await tx.$executeRaw`
      INSERT INTO policy_store."PolicyDecisionRecord" (
        id, tenant_id, decision, policy_version, rule_id, reason_code,
        resource, action, inputs, actor_id, origin, correlation_id, occurred_at
      ) VALUES (
        ${id}::uuid,
        ${input.tenant_id}::uuid,
        ${input.decision},
        ${input.policy_version},
        ${input.rule_id},
        ${input.reason_code},
        ${input.resource},
        ${input.action},
        ${inputsJson}::jsonb,
        ${input.actor_id},
        ${input.origin},
        ${input.correlation_id},
        NOW()
      )
    `;
  }

  // Minimal tenant-scoped declared-status read (ADR-0024 §D13b input for the
  // policy engine). No visibility predicate: the declared status is a fact of
  // the requisition, not an actor-scoped view. Returns null if the requisition
  // does not exist in the tenant.
  async findStatusById(args: { tenant_id: string; id: string }): Promise<RecruitingStatus | null> {
    const row = await this.prisma.requisition.findFirst({
      where: { tenant_id: args.tenant_id, id: args.id },
      select: { status: true },
    });
    return row === null ? null : (row.status as RecruitingStatus);
  }

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
    // L1-A — the resolved creation mode (MANUAL | SYSTEM for create(); the
    // controller derives it from actor_kind). Defaults to MANUAL as the safe
    // fallback for direct callers that do not thread it (real callers pass
    // explicitly). INTEGRATION is the createForImport() path.
    creation_mode?: CreationMode;
    requestId: string;
  }): Promise<RequisitionView> {
    const { tenant_id, entered_by_id, input } = args;
    // L1-A — the initial-state authority gate at the repository floor
    // (Directive §2). Resolves the mode-derived default and validates
    // (mode × requested_status × scopes); throws
    // REQUISITION_INITIAL_STATE_FORBIDDEN (403) BEFORE the data build and any
    // write. There is NO `input.status ?? 'open'` past this point.
    const creationMode: CreationMode = args.creation_mode ?? 'MANUAL';
    const establishedStatus = assertEstablishmentAuthorization({
      mode: creationMode,
      requestedStatus: input.status,
      scopes: args.scopes,
      requestId: args.requestId,
    });
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
    // PR-17 — reject a non-null onsite frequency unless work_arrangement is
    // hybrid, and reject any value outside 1-4. Server-side floor, before persist.
    assertOnsiteDaysPerWeekValid({
      work_arrangement: input.work_arrangement ?? null,
      value: input.onsite_days_per_week ?? null,
      requestId: args.requestId,
    });
    // PR-15 — requisition_number is allocated inside the create transaction
    // (below), so it is intentionally omitted here and spread in at the insert.
    const data: Omit<Prisma.RequisitionUncheckedCreateInput, 'requisition_number'> = {
      tenant_id,
      site_id: input.site_id ?? null,
      title: input.title,
      company_id: input.company_id,
      contact_id: input.contact_id ?? null,
      company_department_id: input.company_department_id ?? null,
      // L1-A — the gate-resolved initial state (mode default applied,
      // authority validated). Replaces the removed `input.status ?? 'open'`.
      status: establishedStatus,
      type: input.type ?? null,
      duration: input.duration ?? null,
      description: input.description ?? null,
      notes: input.notes ?? null,
      is_hot: input.is_hot ?? false,
      openings: input.openings ?? 1,
      // T4-B2 §6 — no openings_available initializer: the stored column is retired;
      // availability is derived from ContractAssignment consumption at read time.
      start_date: input.start_date === undefined ? null : new Date(input.start_date),
      city: input.city ?? null,
      state: input.state ?? null,
      recruiter_id: input.recruiter_id ?? entered_by_id,
      owner_id: input.owner_id ?? entered_by_id,
      entered_by_id,
      ...buildCompensationCreateData(input),
      ...buildEnterpriseCreateData(input, args.requestId),
    };
    // PR-7 (R1) — SET_PRIORITY gate. Governed only when is_hot is set TRUE (R3).
    // On DENY (closed/canceled) it throws 403 and no row is written; on ALLOW the
    // row + its provenance commit atomically.
    const setPriorityProvenance = await this.gateSetPriority({
      tenant_id,
      status: establishedStatus,
      scopes: args.scopes,
      actor_id: entered_by_id,
      requestId: args.requestId,
      enforce: true,
      is_hot: input.is_hot,
    });
    // T1-c — a create ALWAYS runs in a transaction now: the row and its
    // lifecycle event (R1: previous_status NULL) commit atomically, alongside
    // the optional SET_PRIORITY provenance.
    const row = await this.prisma.$transaction(async (tx) => {
      // PR-15 — allocate the per-tenant number in the SAME transaction, then
      // spread it into the insert (assigned at create, never after).
      const requisition_number = await this.allocateRequisitionNumberInTx(tx, tenant_id);
      const created = await tx.requisition.create({ data: { ...data, requisition_number } });
      if (setPriorityProvenance !== null) {
        await insertPolicyDecisionRecordInTx(tx, setPriorityProvenance);
      }
      await this.recordLifecycleEventInTx(tx, {
        tenant_id,
        requisition_id: created.id,
        previous_status: null, // R1 — the created status has no predecessor.
        next_status: (created as RequisitionRow).status,
        actor_id: entered_by_id,
        origin: 'ui',
        // L1-A (Directive §6) — an ordinary manual draft is REQUISITION_CREATED;
        // a governed non-draft establishment (MANUAL-ESTABLISH / SYSTEM) is
        // REQUISITION_ESTABLISHED. Keyed on the gate-resolved status.
        reason_code:
          establishedStatus === 'draft'
            ? LIFECYCLE_REASON_CREATED
            : LIFECYCLE_REASON_ESTABLISHED,
        policy_decision_id: null, // T1-e supplies one.
        correlation_id: args.requestId,
      });
      return created;
    }).catch((err) => {
      // T8-P1 — translate the external-identity partial-unique violation to the
      // exact-name 409; never swallow an arbitrary uniqueness error.
      if (isExternalIdentityIndexViolation(err)) throw externalIdentityConflict(args.requestId);
      throw err;
    });
    return this.projectViewWithCapacity(tenant_id, row as RequisitionRow);
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
    // L1-A — the createForImport() path IS the INTEGRATION mode (Directive
    // v1.1 item 3). The establishment gate closes the generic-CSV hole at the
    // repository floor: authority = the EXISTING requisition:import:write
    // (re-asserted here, not only at the route), and the state matrix refuses
    // draft/pending_approval/archived. Runs BEFORE any write.
    const establishedStatus = assertEstablishmentAuthorization({
      mode: 'INTEGRATION',
      requestedStatus: input.status,
      scopes: args.scopes,
      requestId: args.requestId,
    });
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
    // PR-17 — same onsite-frequency floor as create(); an import is still a
    // write and must not persist an out-of-domain onsite value.
    assertOnsiteDaysPerWeekValid({
      work_arrangement: input.work_arrangement ?? null,
      value: input.onsite_days_per_week ?? null,
      requestId: args.requestId,
    });
    // PR-15 — requisition_number is allocated inside the create transaction
    // (below), so it is intentionally omitted here and spread in at the insert.
    const data: Omit<Prisma.RequisitionUncheckedCreateInput, 'requisition_number'> = {
      tenant_id,
      site_id: input.site_id ?? null,
      title: input.title,
      company_id: input.company_id,
      contact_id: input.contact_id ?? null,
      company_department_id: input.company_department_id ?? null,
      // L1-A — the gate-resolved INTEGRATION initial state (default open
      // preserved). Replaces the removed `input.status ?? 'open'`.
      status: establishedStatus,
      type: input.type ?? null,
      duration: input.duration ?? null,
      description: input.description ?? null,
      notes: input.notes ?? null,
      is_hot: input.is_hot ?? false,
      openings: input.openings ?? 1,
      // T4-B2 §6 — no openings_available initializer: the stored column is retired;
      // availability is derived from ContractAssignment consumption at read time.
      start_date: input.start_date === undefined ? null : new Date(input.start_date),
      city: input.city ?? null,
      state: input.state ?? null,
      recruiter_id: input.recruiter_id ?? entered_by_id,
      owner_id: input.owner_id ?? entered_by_id,
      entered_by_id,
      import_batch_id,
      ...buildCompensationCreateData(input),
      ...buildEnterpriseCreateData(input, args.requestId),
    };
    // PR-7 (R2) — IMPORT is EXEMPT from SET_PRIORITY enforcement: an import is a
    // bulk historical load ("what WAS"), not the operation the lifecycle matrix
    // governs ("what is being DONE"). Gating uniformly would fail a whole import
    // over one terminal-req row, with hand-editing the source file as the only
    // remedy. So enforce=false: we still RECORD the SET_PRIORITY decision (so the
    // exemption is visible, not invisible) and the row proceeds regardless.
    const setPriorityProvenance = await this.gateSetPriority({
      tenant_id,
      status: establishedStatus,
      scopes: args.scopes,
      actor_id: entered_by_id,
      requestId: args.requestId,
      enforce: false,
      is_hot: input.is_hot,
    });
    // T1-c — import is still a create, so it emits a create event (R1:
    // previous_status NULL) with origin=integration (R4). Atomic with the row.
    const row = await this.prisma.$transaction(async (tx) => {
      // PR-15 — an imported requisition is still a requisition; allocate its
      // per-tenant number in the same transaction.
      const requisition_number = await this.allocateRequisitionNumberInTx(tx, tenant_id);
      const created = await tx.requisition.create({ data: { ...data, requisition_number } });
      if (setPriorityProvenance !== null) {
        await insertPolicyDecisionRecordInTx(tx, setPriorityProvenance);
      }
      await this.recordLifecycleEventInTx(tx, {
        tenant_id,
        requisition_id: created.id,
        previous_status: null, // R1 — an imported create has no predecessor.
        next_status: (created as RequisitionRow).status,
        actor_id: entered_by_id,
        origin: 'integration', // R4 — a bulk load must show where a status came from.
        reason_code: LIFECYCLE_REASON_IMPORTED,
        policy_decision_id: null, // T1-e supplies one.
        correlation_id: args.requestId,
      });
      return created;
    }).catch((err) => {
      // T8-P1 — translate the external-identity partial-unique violation to the
      // exact-name 409; never swallow an arbitrary uniqueness error.
      if (isExternalIdentityIndexViolation(err)) throw externalIdentityConflict(args.requestId);
      throw err;
    });
    return this.projectViewWithCapacity(tenant_id, row as RequisitionRow);
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
    // PR-7 — the acting principal, for the SET_PRIORITY §D17a provenance.
    actor_id: string;
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
      // PR-17 — work_arrangement is read so the onsite-frequency rule can key
      // off the EFFECTIVE arrangement (existing value when the PATCH omits it).
      // T8-P1 — source_system/external_req_id needed for the co-presence check
      // against the EFFECTIVE external identity after a partial PATCH.
      select: { id: true, status: true, work_arrangement: true, source_system: true, external_req_id: true },
    });
    if (existing === null) {
      throw new AramoError(
        'NOT_FOUND',
        'Requisition not found in tenant',
        404,
        { requestId: args.requestId, details: { id: args.id } },
      );
    }
    // T1-e (§2.3 / R9) — refuse a status-changing PATCH INTO a subsystem-gated
    // status SERVER-SIDE, before the policy engine runs or any write. A distinct
    // registered code (never a generic 400) that names the refused value so the
    // recruiter learns the status EXISTS but its subsystem does not yet. The
    // gated set is unreachable BY CONSTRUCTION — no package rule expresses it.
    if (args.input.status !== undefined && isGatedRecruitingStatus(args.input.status)) {
      throw new AramoError(
        'REQUISITION_STATUS_GATED',
        'That status is not available yet; its subsystem has not shipped',
        422,
        { requestId: args.requestId, details: { status: args.input.status } },
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
    // PR-0b-1: openings_available is NOT PATCH-writable — pipeline placement
    // transitions are its only mutator. A body carrying it is ignored.
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
    // PR-17 — onsite frequency + its coupling to work_arrangement. effectiveWA
    // is the arrangement AFTER this update (the PATCH's value if present, else
    // the existing one).
    //   (1) field in the PATCH → validate against effectiveWA (reject a non-null
    //       value off-hybrid, and any value outside 1-4), then write it.
    //   (2) field NOT in the PATCH but work_arrangement is changing to a
    //       non-hybrid value → NULL it (a hybrid frequency is meaningless once
    //       the arrangement is no longer hybrid; stale data must not survive the
    //       transition).
    {
      const effectiveWorkArrangement =
        i.work_arrangement !== undefined
          ? i.work_arrangement
          : existing.work_arrangement;
      if (i.onsite_days_per_week !== undefined) {
        assertOnsiteDaysPerWeekValid({
          work_arrangement: effectiveWorkArrangement,
          value: i.onsite_days_per_week,
          requestId: args.requestId,
        });
        data['onsite_days_per_week'] = i.onsite_days_per_week;
      } else if (
        i.work_arrangement !== undefined &&
        i.work_arrangement !== 'hybrid'
      ) {
        data['onsite_days_per_week'] = null;
      }
    }
    if (i.travel_percent !== undefined) data['travel_percent'] = i.travel_percent;
    if (i.relocation_offered !== undefined) data['relocation_offered'] = i.relocation_offered;
    if (i.work_authorization !== undefined) data['work_authorization'] = i.work_authorization;
    if (i.end_date !== undefined) data['end_date'] = i.end_date === null ? null : new Date(i.end_date);
    if (i.duration_value !== undefined) data['duration_value'] = i.duration_value;
    if (i.duration_unit !== undefined) data['duration_unit'] = i.duration_unit;
    if (i.extension_possible !== undefined) data['extension_possible'] = i.extension_possible;
    if (i.hours_per_week !== undefined) data['hours_per_week'] = i.hours_per_week;
    // T8-P1 — canonicalize + validate any external-identity change on PATCH,
    // then enforce co-presence against the EFFECTIVE (post-PATCH) values. Only
    // fields actually present in the PATCH are written (undefined → unchanged).
    {
      const nextSourceSystem =
        i.source_system !== undefined
          ? canonicalizeSourceSystem(i.source_system, args.requestId)
          : undefined;
      const nextExternalReqId =
        i.external_req_id !== undefined
          ? validateExternalReqId(i.external_req_id, args.requestId)
          : undefined;
      if (nextSourceSystem !== undefined) data['source_system'] = nextSourceSystem;
      if (nextExternalReqId !== undefined) data['external_req_id'] = nextExternalReqId;
      const effectiveSourceSystem =
        nextSourceSystem !== undefined ? nextSourceSystem : existing.source_system;
      const effectiveExternalReqId =
        nextExternalReqId !== undefined ? nextExternalReqId : existing.external_req_id;
      assertExternalIdentityCoPresence(
        effectiveSourceSystem,
        effectiveExternalReqId,
        args.requestId,
      );
    }
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

    // PR-7 (R1/R3) — SET_PRIORITY gate on update, governed ONLY when is_hot is
    // being set TRUE. Effective status = the PATCH's new status if provided, else
    // the existing one. On DENY (closed/canceled) → 403, no mutation; on ALLOW
    // the update + its provenance commit atomically.
    const setPriorityProvenance = await this.gateSetPriority({
      tenant_id: args.tenant_id,
      status: (args.input.status ?? existing.status) as string,
      scopes: args.scopes,
      actor_id: args.actor_id,
      requestId: args.requestId,
      enforce: true,
      is_hot: args.input.is_hot,
    });
    // T1-c R2 — emit a lifecycle event ONLY on an ACTUAL status change: a PATCH
    // that omits status, or sets it to its current value, records nothing.
    // previous_status is the pre-update status — never null on an update; a
    // create is the only path that produces a null previous_status.
    const statusChanges =
      args.input.status !== undefined && args.input.status !== existing.status;
    const expectedVersion = args.input.version;
    // T1-e (§2.4) — version becomes MANDATORY the moment a PATCH changes status.
    // Non-status updates keep the T1-b optional/additive posture (making it
    // mandatory everywhere would break every existing caller for no benefit). A
    // status-changing PATCH that omits version is refused BEFORE the policy
    // engine runs and before any write. Generic VALIDATION_ERROR (a missing
    // required control token), distinguished by details.reason — NOT the sibling
    // REQUISITION_VERSION_CONFLICT, which means "you supplied a STALE version".
    if (statusChanges && expectedVersion === undefined) {
      throw new AramoError(
        'VALIDATION_ERROR',
        'version is required for a status-changing update',
        400,
        {
          requestId: args.requestId,
          details: { reason: 'version_required_for_status_change' },
        },
      );
    }
    // T1-e (§2.2 / R8) — route the status change through its GOVERNING action.
    // Every status change is gated here: the four governed targets can be
    // reached ONLY through their action (no direct-set bypass); ungoverned
    // targets (submittals_closed / lead) return null and stay ordinary edits.
    // On DENY gateTransition throws POLICY_DENIED before any write; on ALLOW it
    // returns the §D17a provenance + the decision id to thread into the event.
    const transitionGate = statusChanges
      ? await this.gateTransition({
          tenant_id: args.tenant_id,
          id: args.id,
          from_status: existing.status as RecruitingStatus,
          to_status: args.input.status as RecruitingStatus,
          scopes: args.scopes,
          actor_id: args.actor_id,
          requestId: args.requestId,
        })
      : null;
    // Track 1 T1-b (R1/R3/R4) — the write is a versioned compare-and-swap via
    // casUpdate: args.input.version present → the CAS guards on it (a mismatch is
    // a stale write → 409); absent → unguarded (additive posture) but STILL
    // increments. The version bump lives inside casUpdate, so the plain and the
    // $transaction paths increment identically.
    //
    // T1-b R3 ∧ T1-c R3 ∧ T1-e R4 compose into ONE atomicity guarantee:
    // casUpdate runs FIRST inside the transaction, so a stale-write 409 aborts
    // BEFORE the lifecycle event, the SET_PRIORITY provenance, AND the
    // transition provenance are written — no event and no decision record is
    // ever recorded for a status change that never committed.
    const row =
      setPriorityProvenance === null && !statusChanges
        ? await this.casUpdate(this.prisma, {
            tenant_id: args.tenant_id,
            id: args.id,
            expectedVersion,
            data,
            requestId: args.requestId,
          })
        : await this.prisma.$transaction(async (tx) => {
            const updated = await this.casUpdate(tx, {
              tenant_id: args.tenant_id,
              id: args.id,
              expectedVersion,
              data,
              requestId: args.requestId,
            });
            // Guarded: the tx path is taken when SET_PRIORITY provenance exists
            // OR the status changed, so provenance may be null here (a status-
            // only update with no is_hot assertion).
            if (setPriorityProvenance !== null) {
              await insertPolicyDecisionRecordInTx(tx, setPriorityProvenance);
            }
            // T1-e — persist the governed-transition provenance with the id that
            // the lifecycle event will carry (§2.2). Null for an ungoverned edit.
            if (transitionGate !== null) {
              await this.insertTransitionDecisionRecordInTx(
                tx,
                transitionGate.decision_id,
                transitionGate.provenance,
              );
            }
            if (statusChanges) {
              await this.recordLifecycleEventInTx(tx, {
                tenant_id: args.tenant_id,
                requisition_id: args.id,
                previous_status: existing.status as RecruitingStatus,
                next_status: args.input.status as RecruitingStatus,
                actor_id: args.actor_id,
                origin: 'ui',
                reason_code: LIFECYCLE_REASON_STATUS_CHANGED,
                // T1-e — the governed decision's id (null for an ungoverned edit).
                policy_decision_id: transitionGate?.decision_id ?? null,
                correlation_id: args.requestId,
              });
            }
            return updated;
          });
    return this.projectViewWithCapacity(args.tenant_id, row as RequisitionRow);
  }

  // Track 1 T1-b (ruling R1) — the optimistic-concurrency compare-and-swap.
  // Adds the version bump to `data` so EVERY successful update increments
  // (R1/R3 — a stale write is stale regardless of which field it targets) and,
  // when `expectedVersion` is supplied, guards the WHERE on it. A zero-row
  // result is a STALE WRITE: the caller has already existence-checked the row
  // in tenant, so the only way an id+tenant+version WHERE matches nothing is a
  // version mismatch — someone else changed the row. That is a distinct,
  // registered error (REQUISITION_VERSION_CONFLICT, 409, R2), never a generic
  // 409 and never silent last-write-wins. `expectedVersion` undefined (R4) →
  // no version predicate → unguarded update that still increments. Runs on the
  // passed client (PrismaService or a $transaction client) so it composes with
  // the SET_PRIORITY provenance insert.
  private async casUpdate(
    client: Prisma.TransactionClient,
    args: {
      tenant_id: string;
      id: string;
      expectedVersion: number | undefined;
      data: Record<string, unknown>;
      requestId: string;
    },
  ): Promise<RequisitionRow> {
    const where: Prisma.RequisitionWhereInput = {
      id: args.id,
      tenant_id: args.tenant_id,
      ...(args.expectedVersion !== undefined ? { version: args.expectedVersion } : {}),
    };
    let result: Prisma.BatchPayload;
    try {
      result = await client.requisition.updateMany({
        where,
        data: {
          ...args.data,
          version: { increment: 1 },
        } as Prisma.RequisitionUpdateManyMutationInput,
      });
    } catch (err) {
      // T8-P1 — a PATCH that moves the external identity onto an existing
      // (tenant, source_system, external_req_id) collides on the partial-unique
      // index; translate to the exact-name 409 (never a generic P2002).
      if (isExternalIdentityIndexViolation(err)) throw externalIdentityConflict(args.requestId);
      throw err;
    }
    if (result.count === 0) {
      throw new AramoError(
        'REQUISITION_VERSION_CONFLICT',
        'The requisition was modified by another request; reload and retry',
        409,
        { requestId: args.requestId, details: { id: args.id } },
      );
    }
    const row = await client.requisition.findFirstOrThrow({
      where: { id: args.id, tenant_id: args.tenant_id },
    });
    return row as RequisitionRow;
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
    // Track 1 T1-b (R3) — stampGoldenProfileId increments the version like any
    // other successful update; NO exemption. It is not a client-supplied CAS
    // caller, so it passes no expectedVersion (unguarded), but the token still
    // bumps so a concurrent PATCH holding the old version sees the change.
    const row = await this.casUpdate(this.prisma, {
      tenant_id: args.tenant_id,
      id: args.id,
      expectedVersion: undefined,
      data: { golden_profile_id: args.golden_profile_id },
      requestId: args.requestId,
    });
    return this.projectViewWithCapacity(args.tenant_id, row as RequisitionRow);
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
    // PR-14 — "My Bookmarks" filter. When true, NARROWS to requisitions the
    // caller has personally bookmarked (ANDs a relation-EXISTS on the caller's
    // own state row within the visible set — never widens visibility, never
    // reads another user's bookmarks). The caller identity comes from
    // visibility.actor_user_id (the authenticated actor).
    bookmarked_only?: boolean;
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
        // PR-14 — "My Bookmarks": a correlated EXISTS on the CALLER's own
        // bookmarked state row. ANDs as a sibling of the visibility union —
        // narrows within the visible set, never widens it.
        ...(args.bookmarked_only
          ? {
              user_requisition_state: {
                some: {
                  user_id: args.visibility.actor_user_id,
                  bookmarked_at: { not: null },
                },
              },
            }
          : {}),
        ...buildVisibilityWhere(args.visibility),
      },
      orderBy: { created_at: 'desc' },
      take: limit,
    });
    // T4-B2 — ONE set-oriented capacity read for the whole page (never N per-row
    // reads in a loop). Each row's openings_available is the derived value; a
    // requisition absent from the map has zero ACTIVE assignments (consuming 0).
    const typedRows = rows as RequisitionRow[];
    const activeByReq = await this.capacity.countActiveByRequisitionIds(
      args.tenant_id,
      typedRows.map((r) => r.id),
    );
    const views = typedRows.map((r) => {
      const capacity = deriveCapacity({
        openings: r.openings,
        consuming_count: activeByReq.get(r.id) ?? 0,
      });
      return projectView(r, capacity.openings_available, capacity.capacity_balance);
    });
    // L8-B2 — ONE set-oriented Client Status read for the whole page (same rule as
    // capacity); fail-soft so it can never break the list.
    const withClientStatus = await this.enrichClientStatus(args.tenant_id, views);
    return this.enrichBookmarked(
      args.tenant_id,
      args.visibility.actor_user_id,
      withClientStatus,
    );
  }

  /**
   * L8-B2 — enrich a page of views with authoritative requisition-grain Client Status
   * (SubmittalEligibility truth). SET-oriented; **fail-soft** per R-DEFAULT-OPEN — a
   * reader error leaves the fields null (the UI renders null as OPEN, never "Unknown"),
   * and the list never 500s.
   */
  private async enrichClientStatus(
    tenant_id: string,
    views: RequisitionView[],
  ): Promise<RequisitionView[]> {
    if (views.length === 0) return views;
    try {
      const byReq = await this.clientStatus.deriveByRequisitionIds(
        tenant_id,
        views.map((v) => v.id),
        new Date(),
      );
      return views.map((v) => {
        const cs = byReq.get(v.id);
        return cs === undefined
          ? v
          : {
              ...v,
              client_submittal_status: cs.status,
              client_submittal_reason: cs.reason,
            };
      });
    } catch (err) {
      new Logger(RequisitionRepository.name).warn(
        `client-status enrichment failed (fail-soft, fields left null): ${(err as Error).message}`,
      );
      return views;
    }
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
    if (row === null) return null;
    // PR-14 — enrich the personal `bookmarked` flag for the calling user
    // (visibility.actor_user_id).
    // L8-B2 — detail carries Client Status via projectViewWithCapacity (enriched there).
    const enriched = await this.enrichBookmarked(
      args.tenant_id,
      args.visibility.actor_user_id,
      [await this.projectViewWithCapacity(args.tenant_id, row as RequisitionRow)],
    );
    return enriched[0] ?? null;
  }

  // -------------------------------------------------------------------------
  // PR-14 (Track C) — personal bookmark state
  // -------------------------------------------------------------------------

  /**
   * Enrich a set of views with the CALLING user's personal `bookmarked` flag.
   * One indexed lookup on user_requisition_state (leads with
   * (tenant_id, user_id)) resolves every row. Reads ONLY the actor's own
   * rows — a bookmark is never visible to another user.
   */
  private async enrichBookmarked(
    tenant_id: string,
    actor_user_id: string,
    views: RequisitionView[],
  ): Promise<RequisitionView[]> {
    if (views.length === 0) return views;
    const bookmarked = await this.prisma.userRequisitionState.findMany({
      where: {
        tenant_id,
        user_id: actor_user_id,
        requisition_id: { in: views.map((v) => v.id) },
        bookmarked_at: { not: null },
      },
      select: { requisition_id: true },
    });
    const bookmarkedIds = new Set(bookmarked.map((b) => b.requisition_id));
    return views.map((v) => ({ ...v, bookmarked: bookmarkedIds.has(v.id) }));
  }

  /**
   * Set (idempotently) the calling user's bookmark state for a requisition.
   *
   * PERSONAL: writes only the actor's own state row; never touches is_hot
   * (team-wide) and never affects ranking or sort for anyone else. Idempotent
   * SET semantics — the caller supplies the desired state, so repeated calls
   * converge and re-bookmarking preserves the original bookmarked_at.
   *
   * Visibility-scoped: bookmarking a requisition outside the actor's visible
   * set (or in another tenant) returns 404 — the same contract as the read
   * paths, so a bookmark cannot be used to probe for hidden rows.
   */
  async setBookmark(args: {
    tenant_id: string;
    actor_user_id: string;
    id: string;
    bookmarked: boolean;
    visibility: VisibilityContextShape;
    requestId: string;
  }): Promise<RequisitionView> {
    const view = await this.findByIdForActor({
      tenant_id: args.tenant_id,
      id: args.id,
      visibility: args.visibility,
    });
    if (view === null) {
      throw new AramoError(
        'NOT_FOUND',
        'Requisition not found in tenant (or not visible to actor)',
        404,
        { requestId: args.requestId, details: { id: args.id } },
      );
    }
    const locator = {
      tenant_id_user_id_requisition_id: {
        tenant_id: args.tenant_id,
        user_id: args.actor_user_id,
        requisition_id: args.id,
      },
    };
    const existing = await this.prisma.userRequisitionState.findUnique({
      where: locator,
      select: { bookmarked_at: true },
    });
    // Un-bookmarking a row that is already absent/not-bookmarked is a no-op
    // (no empty row is created) — idempotent.
    if (!args.bookmarked && (existing === null || existing.bookmarked_at === null)) {
      return { ...view, bookmarked: false };
    }
    // Re-bookmarking preserves the first bookmarked_at (idempotent — no
    // observable change on repeat); un-bookmarking clears it.
    const bookmarked_at = args.bookmarked
      ? existing?.bookmarked_at ?? new Date()
      : null;
    await this.prisma.userRequisitionState.upsert({
      where: locator,
      create: {
        tenant_id: args.tenant_id,
        user_id: args.actor_user_id,
        requisition_id: args.id,
        bookmarked_at,
      },
      update: { bookmarked_at },
    });
    return { ...view, bookmarked: args.bookmarked };
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
    return row === null
      ? null
      : this.projectViewWithCapacity(args.tenant_id, row as RequisitionRow);
  }

  // SRC-2 PR-3 (DEV-E) — the distribution sweep's publishable read. SYSTEM-class
  // (no actor/visibility filter — the sweep is a tenant-agnostic background job),
  // mirroring findByIdAdmin's admin posture but for a list, filtered to the
  // publishable predicate (status open AND public_listing). The `select` is a
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
        status: 'open',
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
  // Mirrors `countForActor` but groups by the RecruitingStatus enum so
  // the reports endpoint can show a per-status bucket map. Prisma
  // groupBy with where preserves the same A3 predicate (`assignments:
  // { some: ... }`).
  async countByStatusForActor(args: {
    tenant_id: string;
    visibility: VisibilityContextShape;
    site_id?: string;
  }): Promise<Array<{ status: RecruitingStatus; count: number }>> {
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
      status: r.status as RecruitingStatus,
      count: r._count._all,
    }));
  }

  // T9-B1 — fill-performance cohort read. Returns the requisitions whose
  // `created_at ∈ [from, to)` (amendment D-3) within the actor's A3-visible
  // set (buildVisibilityWhere) + tenant + optional site. Period-bounded by
  // the [from,to) predicate — deliberately NOT the 200/1000-capped
  // listForActor fold (directive §6 / amendment D-6), and no per-row capacity
  // read: openings_available is irrelevant to the pipeline-`placed` fill
  // authority (D-1). Minimal projection — the fill/TTF math needs only
  // id + openings + status + created_at.
  async listCohortForActor(args: {
    tenant_id: string;
    visibility: VisibilityContextShape;
    from: Date;
    to: Date;
    site_id?: string;
  }): Promise<
    Array<{
      id: string;
      openings: number;
      status: RecruitingStatus;
      created_at: Date;
    }>
  > {
    const rows = await this.prisma.requisition.findMany({
      where: {
        tenant_id: args.tenant_id,
        ...(args.site_id === undefined ? {} : { site_id: args.site_id }),
        // Cohort by original creation instant; REOPEN never rewrites
        // created_at so the clock is not restarted (directive §7).
        created_at: { gte: args.from, lt: args.to },
        ...buildVisibilityWhere(args.visibility),
      },
      select: { id: true, openings: true, status: true, created_at: true },
      orderBy: { created_at: 'asc' },
    });
    return rows.map((r) => ({
      id: r.id as string,
      openings: r.openings as number,
      status: r.status as RecruitingStatus,
      created_at: r.created_at as Date,
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

  // T9-B5 / AV-1 — resolve EVERY requisition id in a tenant's site, unbounded and
  // set-based (single SELECT id over the existing requisition.site_id column; NO
  // schema change, NO limit cap, NO N+1). Used by the reporting service to narrow
  // the fallthrough / assignment-pipeline / margin aggregates to an explicitly
  // requested site for tenant-wide (see_all) principals, whose visibility does NOT
  // constrain the requisition set — so `listForActor`'s 200-row cap cannot be used
  // to enumerate a site completely. tenant-scoped; returns [] for an empty site.
  async findRequisitionIdsForTenantSite(args: {
    tenant_id: string;
    site_id: string;
  }): Promise<string[]> {
    const rows = await this.prisma.requisition.findMany({
      where: { tenant_id: args.tenant_id, site_id: args.site_id },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }
}
