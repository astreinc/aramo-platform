import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  REQUIREMENT_TYPE_VALUES,
  WAIVER_AUTHORITY_VALUES,
  WAIVER_MODE_VALUES,
} from '@aramo/pre-start-requirement';

// Track 3 / E2 — HTTP request DTOs (apps/api, the guarded surface). scope is
// server-derived (TENANT-only, §4b): the controller sets scope='TENANT' and
// scope_ref_id=tenant_id from the JWT; a client never chooses scope.

// A single definition within a set. requirement_type / waiver_mode are validated
// against the closed lib registries — an out-of-list value is a 422 domain error,
// never free text introducing executable semantics (§4c).
export class RequirementDefinitionDto {
  @IsIn(REQUIREMENT_TYPE_VALUES as readonly string[])
  requirement_type!: string;

  @IsString()
  @IsNotEmpty()
  label!: string;

  @IsBoolean()
  blocking!: boolean;

  @IsOptional()
  @IsString()
  owner_role?: string | null;

  @IsInt()
  @Min(0)
  sequence!: number;

  @IsIn(WAIVER_MODE_VALUES as readonly string[])
  waiver_mode!: string;
}

export class CreateDraftSetDto {
  @IsString()
  @IsNotEmpty()
  version!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => RequirementDefinitionDto)
  definitions!: RequirementDefinitionDto[];
}

export class EditDraftSetDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => RequirementDefinitionDto)
  definitions!: RequirementDefinitionDto[];
}

// A non-waiver operational status move on the `:act` route. Deliberately EXCLUDES
// (v1.2.2):
//   - WAIVED   — the waiver route (data-dependent waive_blocking / waive_advisory).
//   - PENDING  — reopen is a privileged action on its OWN :reopen-scoped route.
//   - CANCELED — cancellation is a governed system action, never a user endpoint
//                (§14 A2-C); `:act` may not cancel.
// What remains is the ordinary operational work: start, satisfy, fail.
const STATUS_MOVE_TARGETS = ['IN_PROGRESS', 'SATISFIED', 'FAILED'] as const;

export class StatusMoveDto {
  @IsIn(STATUS_MOVE_TARGETS as readonly string[])
  to!: string;

  @IsOptional()
  @IsString()
  reason?: string;

  @IsOptional()
  @IsString()
  justification?: string;

  @IsOptional()
  @IsString()
  source?: string;

  @IsOptional()
  @IsString()
  completed_by?: string;

  @IsOptional()
  @IsString()
  evidence_reference?: string;
}

// Reopen — the privileged audited action returning a resolved/failed instance to
// PENDING. Its own route, gated by pre_start_requirement:reopen (zero default
// grants). A justification is required (a reopen reverses a compliance outcome).
export class ReopenDto {
  @IsString()
  @IsNotEmpty()
  justification!: string;

  @IsOptional()
  @IsString()
  source?: string;
}

export class WaiveDto {
  @IsIn(WAIVER_AUTHORITY_VALUES as readonly string[])
  authority!: string;

  @IsString()
  @IsNotEmpty()
  justification!: string;

  @IsOptional()
  @IsString()
  source?: string;

  // L5-P5 — optional supporting evidence pointer for the waiver.
  @IsOptional()
  @IsString()
  evidence_reference?: string;
}

// L5-P6 — the governed verification of a VERIFICATION_REQUIRED requirement.
export class VerifyDto {
  @IsOptional()
  @IsString()
  justification?: string;

  @IsOptional()
  @IsString()
  source?: string;

  @IsOptional()
  @IsString()
  evidence_reference?: string;
}
