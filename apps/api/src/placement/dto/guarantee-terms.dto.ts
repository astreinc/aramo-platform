import { IsIn, IsInt, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { REMEDY_POLICIES, GUARANTEE_TERMS_SOURCE_TYPES } from '@aramo/placement';

// Track 7 / T7-P3 — HTTP request DTOs for the reusable guarantee-term-versioning surface
// (directive §8). tenant_id + recorded_by are server-derived from the JWT, never the body;
// requisition_id is the path parameter. The repository re-validates every field at the write
// boundary (defence in depth) — these decorators are the first fail-closed gate.
const MONEY_12_2 = /^\d{1,10}(\.\d{1,2})?$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const OPTIONAL_TEXT_MAX = 255;

// The reusable guarantee-term payload shared by create + revise (§3.3 / §3.6).
class GuaranteeTermPayloadDto {
  // Calendar date the terms become effective (create) or the successor start / first-close
  // boundary (revise). Half-open window; DATE semantics (no timezone).
  @Matches(ISO_DATE, { message: 'effective_from must be a calendar date (yyyy-mm-dd)' })
  effective_from!: string;

  @IsInt()
  guarantee_duration_days!: number;

  @IsIn(REMEDY_POLICIES as readonly string[])
  remedy_policy!: string;

  @Matches(MONEY_12_2, { message: 'guarantee_exposure_amount must be a non-negative Decimal(12,2) money string' })
  guarantee_exposure_amount!: string;

  @IsString()
  @MaxLength(8)
  currency!: string;

  @IsIn(GUARANTEE_TERMS_SOURCE_TYPES as readonly string[])
  source_type!: string;

  @IsOptional()
  @IsString()
  @MaxLength(OPTIONAL_TEXT_MAX)
  source_reference?: string;

  @IsOptional()
  @IsString()
  @MaxLength(OPTIONAL_TEXT_MAX)
  source_version?: string;

  @IsOptional()
  @IsString()
  @MaxLength(OPTIONAL_TEXT_MAX)
  correlation_id?: string;
}

// POST /v1/permanent-placement-guarantee-terms/requisitions/:requisitionId — create initial.
export class CreateGuaranteeTermsDto extends GuaranteeTermPayloadDto {}

// POST /v1/permanent-placement-guarantee-terms/requisitions/:requisitionId/revise — first-close
// the current version and insert the successor.
export class ReviseGuaranteeTermsDto extends GuaranteeTermPayloadDto {}
