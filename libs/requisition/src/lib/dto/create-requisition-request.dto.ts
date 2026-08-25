import { IsBoolean, IsIn, IsNumber, IsOptional, IsString } from 'class-validator';

import type { RatePeriod } from './rate-period.js';
import type { RequisitionCompensationModel } from './requisition-compensation-model.js';
import { RECRUITING_STATUS_VALUES, type RecruitingStatus } from './requisition-status.js';

// CreateRequisitionRequestDto — POST /v1/requisitions payload.
// tenant_id is derived from AuthContext.tenant_id, never the body.
//
// Requisition Lane 1-A (Create-Governance) — this is the FIRST validated
// CLASS DTO in libs/requisition. It is imported as a VALUE by the controller
// so the global ValidationPipe (whitelist + forbidNonWhitelisted + transform,
// apps/api/src/main.ts) enforces it: `status` must be a member of
// RECRUITING_STATUS_VALUES (enum-invalid -> VALIDATION_ERROR 400, distinct
// from the establishment gate's 403), and unknown props are rejected. Every
// field carries a validation decorator — an undecorated field would be
// silently stripped under whitelist. The initial-STATE authority
// (creation-mode × status × scopes) is enforced separately at the repository
// floor by establishment-authorization-gate.ts.
//
// Compensation-Field Modeling v1.1 §2 — the structured comp surface.
// All comp fields optional; the discriminator (compensation_model)
// labels which set is meaningful (CONTRACT → bill/pay; PERMANENT →
// placement_fee + structured salary). Decimal money fields are
// accepted as strings to preserve precision over the wire (the
// repository turns them into Prisma.Decimal at the boundary).
export class CreateRequisitionRequestDto {
  @IsString()
  title!: string;

  @IsString()
  company_id!: string;

  @IsOptional()
  @IsString()
  site_id?: string;

  @IsOptional()
  @IsString()
  contact_id?: string;

  @IsOptional()
  @IsString()
  company_department_id?: string;

  @IsOptional()
  @IsIn(RECRUITING_STATUS_VALUES as unknown as string[])
  status?: RecruitingStatus;

  @IsOptional()
  @IsString()
  type?: string;

  @IsOptional()
  @IsString()
  duration?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsBoolean()
  is_hot?: boolean;

  @IsOptional()
  @IsNumber()
  openings?: number;

  // openings_available is intentionally NOT writable via the API (PR-0b-1).
  // It is an availability counter mutated ONLY by pipeline placement
  // transitions; on create it initialises to `openings`.
  @IsOptional()
  @IsString()
  start_date?: string;

  @IsOptional()
  @IsString()
  city?: string;

  @IsOptional()
  @IsString()
  state?: string;

  @IsOptional()
  @IsString()
  recruiter_id?: string;

  @IsOptional()
  @IsString()
  owner_id?: string;

  // v1.1 §2.3 discriminator.
  @IsOptional()
  @IsString()
  compensation_model?: RequisitionCompensationModel;

  // v1.1 §2.1 — the two stored facts (CONTRACT). Money fields are
  // decimal strings ("60.00") — Decimal-safe wire format.
  @IsOptional()
  @IsString()
  pay_rate_amount?: string;

  @IsOptional()
  @IsString()
  pay_rate_currency?: string;

  @IsOptional()
  @IsString()
  pay_rate_period?: RatePeriod;

  @IsOptional()
  @IsString()
  bill_rate_amount?: string;

  @IsOptional()
  @IsString()
  bill_rate_currency?: string;

  @IsOptional()
  @IsString()
  bill_rate_period?: RatePeriod;

  // v1.1 §2.3 — PERMANENT-side fields.
  @IsOptional()
  @IsString()
  placement_fee_percent?: string;

  @IsOptional()
  @IsString()
  placement_fee_amount?: string;

  @IsOptional()
  @IsString()
  salary_amount?: string;

  @IsOptional()
  @IsString()
  salary_currency?: string;

  // ---- Job-Module enterprise fields (§1 Part 1, additive, UN-gated) ----
  // String-not-enum closed vocabularies (R7). Numeric fields are numbers;
  // booleans default false at the repository when omitted.
  @IsOptional()
  @IsString()
  job_type?: string;

  @IsOptional()
  @IsString()
  labor_category?: string;

  @IsOptional()
  @IsString()
  role_family?: string;

  @IsOptional()
  @IsString()
  seniority_level?: string;

  @IsOptional()
  @IsString()
  headcount_reason?: string;

  @IsOptional()
  @IsString()
  work_arrangement?: string;

  // PR-17 — hybrid onsite frequency (1-4). Server rejects a value when
  // work_arrangement is not 'hybrid', and any value outside 1-4.
  @IsOptional()
  @IsNumber()
  onsite_days_per_week?: number;

  @IsOptional()
  @IsNumber()
  travel_percent?: number;

  @IsOptional()
  @IsBoolean()
  relocation_offered?: boolean;

  @IsOptional()
  @IsString()
  work_authorization?: string;

  @IsOptional()
  @IsString()
  end_date?: string;

  @IsOptional()
  @IsNumber()
  duration_value?: number;

  @IsOptional()
  @IsString()
  duration_unit?: string;

  @IsOptional()
  @IsBoolean()
  extension_possible?: boolean;

  @IsOptional()
  @IsNumber()
  hours_per_week?: number;

  @IsOptional()
  @IsString()
  source_system?: string;

  @IsOptional()
  @IsString()
  external_req_id?: string;

  @IsOptional()
  @IsString()
  imported_at?: string;

  // ---- Requisition Record Spec Amendment v1.0 (additive, UN-gated) -----
  // rate_type is guarded against the closed allowlist (C2C|W2|1099|Any) at
  // the controller boundary. run_match_on_create is the stored run-match
  // INTENT flag (reserves matching; triggers nothing at create).
  @IsOptional()
  @IsString()
  rate_type?: string;

  @IsOptional()
  @IsBoolean()
  allow_subcontractors?: boolean;

  @IsOptional()
  @IsBoolean()
  run_match_on_create?: boolean;

  // ---- Gated financial-planning fields (🔒 requisition:edit:financials) -
  // LB-4: write-gated by the financial edit-gate at the repository
  // boundary. Decimal money/percent fields are decimal strings (Decimal-
  // safe wire format, like the comp fields). NOT the compensation family.
  @IsOptional()
  @IsString()
  target_margin_percent?: string;

  @IsOptional()
  @IsString()
  markup_percent_target?: string;

  @IsOptional()
  @IsString()
  rate_card_id?: string;

  @IsOptional()
  @IsString()
  min_bill_rate?: string;

  @IsOptional()
  @IsString()
  max_bill_rate?: string;

  @IsOptional()
  @IsString()
  min_pay_rate?: string;

  @IsOptional()
  @IsString()
  max_pay_rate?: string;
}
