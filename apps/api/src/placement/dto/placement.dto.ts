import {
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { PLACEMENT_STATES, PLACEMENT_KINDS, PERMANENT_PLACEMENT_STATES, PERMANENT_FALLOFF_REASON_CODES, REMEDY_POLICIES, USER_CANCELLATION_REASON_CODES } from '@aramo/placement';
import { RATE_PERIOD_VALUES } from '@aramo/common';

// Track 5 / T5-P1 — a decimal money string (never a float): up to 10 integer
// digits and up to 2 fractional, matching the Decimal(12,2) storage column and
// the money-at-boundary convention. Non-negative; the closed currency / rate
// period sets are the libs/common shared value objects.
const MONEY_12_2 = /^\d{1,10}(\.\d{1,2})?$/;

// Track 3 / E1-b — HTTP request DTOs for the PlacementProcess surface. tenant_id
// is server-derived from the JWT, never the body.

// E1-c (9-c-1) — bounds for the free-text offer-snapshot fields. Non-sensitive
// operational metadata only (NO commercial rates / restricted evidence).
const CLIENT_OFFER_REFERENCE_MAX = 255;
const OFFER_TERMS_SUMMARY_MAX = 2000;
// E3 — reason-detail bound; matches the repository REASON_DETAIL_MAX registry
// constant (the shared recruiter-justification convention). The DTO cap is a
// cheap wire guard; the registry classifier is the authoritative policy gate.
const REASON_DETAIL_MAX = 2000;

export class CreatePlacementDto {
  @IsUUID()
  submittal_id!: string;

  @IsUUID()
  requisition_id!: string;

  @IsUUID()
  talent_record_id!: string;

  // E1-c offer snapshot (9-c-1). All optional at the wire; offered_at defaults to
  // the server time of the offer fact when omitted. offer_expires_at, when present,
  // must not precede offered_at (enforced in the repository, VALIDATION_ERROR 400).
  @IsOptional()
  @IsDateString()
  offered_at?: string;

  @IsOptional()
  @IsDateString()
  proposed_start_date?: string;

  @IsOptional()
  @IsDateString()
  offer_expires_at?: string;

  @IsOptional()
  @IsString()
  @MaxLength(CLIENT_OFFER_REFERENCE_MAX)
  client_offer_reference?: string;

  @IsOptional()
  @IsString()
  @MaxLength(OFFER_TERMS_SUMMARY_MAX)
  offer_terms_summary?: string;

  // E4 — replacement lineage. When present, this create is a replacement of a
  // terminal predecessor: it additionally requires placement:replace (a
  // conjunction with placement:create, enforced in the controller, §3), and the
  // repository validates existence, tenant, requisition and pre-start-terminal
  // eligibility (§5, PLACEMENT_REPLACEMENT_INVALID 422). Absent → an ordinary
  // first creation, unchanged.
  @IsOptional()
  @IsUUID()
  replaces_placement_process_id?: string;

  // Track 7 / T7-P1 — the permanent-vs-contract branch fact, persisted once at
  // create (§3.1). Optional at the wire: omitted => NULL (legacy/CONTRACT-
  // compatible at STARTED). An explicit PERMANENT is required to later start a
  // permanent placement (the guarantee path). Closed set — an unknown value is a
  // 400 wire failure.
  @IsOptional()
  @IsIn(PLACEMENT_KINDS as readonly string[])
  placement_kind?: string;
}

// Track 7 / T7-P1 — the governed guarantee terms supplied at the PERMANENT
// STARTED handoff, a cohesive nested value object (mirroring CommercialTermsDto,
// NOT loose top-level fields). REQUIRED by the repository for a PERMANENT start,
// REJECTED for a CONTRACT/NULL start or a non-STARTED target (VALIDATION_ERROR).
// guarantee_start_date is a calendar date; guarantee_duration_days a positive
// integer; remedy_policy exactly one closed policy; exposure a decimal money
// string + ISO-4217 currency; terms_source a governed provenance label. The
// repository re-validates every rule at the write boundary (fail-closed).
export class GuaranteeTermsDto {
  @IsDateString()
  guarantee_start_date!: string;

  // Positive integer enforced at the repository write boundary
  // (PERMANENT_PLACEMENT_GUARANTEE_WINDOW_INVALID); the DTO guarantees it is a number.
  @Type(() => Number)
  @IsInt()
  guarantee_duration_days!: number;

  @IsIn(REMEDY_POLICIES as readonly string[])
  remedy_policy!: string;

  @IsString()
  @Matches(MONEY_12_2)
  exposure_amount!: string;

  @IsString()
  @MaxLength(3)
  exposure_currency!: string;

  @IsString()
  @MaxLength(255)
  terms_source!: string;
}

// Track 5 / T5-P1 — the actual person-specific commercial terms of the initial
// Assignment Rate Version, a cohesive nested value object (Amendment A2 §2, NOT
// four unrelated top-level fields). REQUIRED for a FORWARD transition to STARTED;
// supplying it on any other target is rejected (VALIDATION_ERROR — the repository
// enforces the target-state policy). Amounts are decimal money strings (never
// float). ONE currency governs BOTH pay and bill (Amendment A1-9). rate_period is
// the libs/common shared closed set; currency is validated against the libs/common
// ISO-4217 set at the repository write boundary.
export class CommercialTermsDto {
  @IsString()
  @Matches(MONEY_12_2)
  pay_rate_amount!: string;

  @IsString()
  @Matches(MONEY_12_2)
  bill_rate_amount!: string;

  @IsString()
  @MaxLength(3)
  currency!: string;

  @IsIn(RATE_PERIOD_VALUES as readonly string[])
  rate_period!: string;
}

// Track 6 / T6-B2 — a post-start commercial revision request. The same four
// commercial fields as the initial terms (money strings + closed currency/rate
// period sets, re-validated at the repository write boundary), PLUS:
//   effective_from — OPTIONAL ISO-8601 instant; omitted => the server generates ONE
//     "now" instant used for BOTH the predecessor close and the successor open (the
//     clock is never called twice). A supplied instant materially in the past is
//     refused at the repository (VALIDATION_ERROR); current/future is permitted iff
//     all interval/overlap invariants hold.
//   change_reason — REQUIRED (directive §6.2); trimmed non-empty, max 2000 chars,
//     stored on the successor version. No reason-code enum in B2 (free text).
// Server-derived / FORBIDDEN on the wire: tenant, assignment/version ids,
// requisition/talent lineage, recorded_by (JWT sub), cancellation fields,
// effective_to (the governed close is a server act).
export class CommercialRevisionDto {
  @IsString()
  @Matches(MONEY_12_2)
  pay_rate_amount!: string;

  @IsString()
  @Matches(MONEY_12_2)
  bill_rate_amount!: string;

  @IsString()
  @MaxLength(3)
  currency!: string;

  @IsIn(RATE_PERIOD_VALUES as readonly string[])
  rate_period!: string;

  @IsOptional()
  @IsDateString()
  effective_from?: string;

  // Required (no @IsOptional). Trimmed-non-empty is enforced at the repository
  // write boundary (VALIDATION_ERROR) — the cap here is a cheap wire guard.
  @IsString()
  @MaxLength(2000)
  change_reason!: string;
}

// Track 6 / T6-B3 — explicit cancellation of a FUTURE open-tail commercial
// revision. The ONLY wire field is the cancellation reason, constrained to the
// closed USER-selectable vocabulary (directive §10). The reserved internal
// ASSIGNMENT_ENDED is deliberately NOT in this set, so a request carrying it is a
// wire validation failure (400) — the explicit API can never mint the END-only
// reason. Everything else (tenant, assignment, revision id, cancelled_at,
// cancelled_by = JWT sub) is server-derived and FORBIDDEN on the wire.
export class CancelCommercialRevisionDto {
  @IsIn(USER_CANCELLATION_REASON_CODES as readonly string[])
  cancellation_reason_code!: string;
}

// One generic transition route (E1-b §1): the target state is in the body and the
// canonical 14-edge matrix enforces legality. `to` must be a known placement
// state; an illegal EDGE is a domain refusal (PLACEMENT_STATE_INVALID, 422).
export class TransitionPlacementDto {
  @IsIn(PLACEMENT_STATES as readonly string[])
  to!: string;

  // E3 — governed terminal/fallthrough reason evidence. Optional at the wire:
  // a transition into a governed terminal state REQUIRES reason_code and a
  // non-governed edge must omit it — both enforced by the registry classifier in
  // the repository (PLACEMENT_REASON_INVALID, 422), not by class-validator, so the
  // closed reason vocabulary survives. snake_case matches the create DTO's
  // serialization convention. A stable code only — a display label is rejected.
  @IsOptional()
  @IsString()
  reason_code?: string;

  @IsOptional()
  @IsString()
  @MaxLength(REASON_DETAIL_MAX)
  reason_detail?: string;

  // Track 4 / T4-A1 — org snapshot for the forward STARTED -> ContractAssignment
  // path. company_id is required by the repository ONLY for a transition to
  // STARTED (the FORWARD provenance CHECK). INTERIM: caller-supplied here; T4-D
  // hardens this to a SERVER-AUTHORITATIVE derive from the requisition (the
  // controller reads the requisition org context rather than trusting the wire).
  // Tracked as a T4-D boundary — do not treat this wire field as the final shape.
  @IsOptional()
  @IsUUID()
  assignment_company_id?: string;

  @IsOptional()
  @IsUUID()
  assignment_site_id?: string;

  @IsOptional()
  @IsUUID()
  assignment_department_id?: string;

  // Track 5 / T5-P1 — actual commercial terms for the FORWARD STARTED path.
  // Optional at the wire; the repository REQUIRES it for a transition to STARTED
  // (PLACEMENT_START_COMMERCIAL_TERMS_REQUIRED, 422) and REJECTS it for any other
  // target (VALIDATION_ERROR) — a target-state-dependent policy, so not expressible
  // by class-validator alone.
  @IsOptional()
  @ValidateNested()
  @Type(() => CommercialTermsDto)
  commercial_terms?: CommercialTermsDto;

  // Track 7 / T7-P1 — governed guarantee terms for the PERMANENT STARTED path.
  // Optional at the wire; the repository REQUIRES it for a PERMANENT start
  // (PERMANENT_PLACEMENT_TERMS_REQUIRED, 422) and REJECTS it for a CONTRACT/NULL
  // start or a non-STARTED target (VALIDATION_ERROR) — a kind-and-target-dependent
  // policy, so not expressible by class-validator alone.
  @IsOptional()
  @ValidateNested()
  @Type(() => GuaranteeTermsDto)
  guarantee_terms?: GuaranteeTermsDto;
}

// Track 4 / T4-D — ending a ContractAssignment. The ratified end-reason taxonomy
// (closed set) distinguishes the three business categories structurally.
export class EndAssignmentDto {
  @IsIn(['COMPLETED', 'WORKER_ENDED', 'CLIENT_ENDED'])
  end_reason!: string;
}

// Track 7 / T7-P1 — one generic governed guarantee-lifecycle transition (directive
// §14): the target state is in the body and the typed transition registry enforces
// legality (PERMANENT_PLACEMENT_STATE_INVALID, 422). P1 ships the single legal edge
// GUARANTEE_ACTIVE -> GUARANTEE_SATISFIED; `to` must be a known permanent-placement
// state. No named outcome routes.
export class PermanentPlacementTransitionDto {
  @IsIn(PERMANENT_PLACEMENT_STATES as readonly string[])
  to!: string;
}

// Track 7 / T7-P2 — the governed guarantee-falloff command body (§11). effective_date is
// an ISO calendar date (the repository validates the half-open window); reason is a code
// from the closed T7 permanent-falloff registry (exact-match, no OTHER — §3.1). The actor
// (recorded_by) is the JWT subject, server-derived and FORBIDDEN on the wire.
export class FalloffDto {
  @IsDateString()
  effective_date!: string;

  @IsIn(PERMANENT_FALLOFF_REASON_CODES as readonly string[])
  reason!: string;
}

// Track 7 / T7-P2 — the evidence-gated remedy-completion command body (§9 / §11). Exactly
// one field is supplied depending on the immutable remedy type — REPLACEMENT carries
// replacement_placement_process_id, REFUND/PRORATED_CREDIT carry external_reference — and
// the repository enforces the coherence + the governed replacement checks. The caller
// NEVER supplies the amount; completed_by is the JWT subject, FORBIDDEN on the wire.
export class RemedyCompletionDto {
  @IsOptional()
  @IsUUID()
  replacement_placement_process_id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  external_reference?: string;
}
