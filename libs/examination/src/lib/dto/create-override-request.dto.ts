import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

import type { OverrideTypeValue } from '../examination.repository.js';

// M4 PR-5 §4.5 — HTTP request / response DTOs for POST
// /v1/examinations/{examination_id}/overrides.
//
// CreateOverrideRequestDto carries only the recruiter-authored fields;
// tenant_id + created_by + examination_id are derived from the auth
// context and path parameter at the controller boundary.
//
// class-validator decorators back the global ValidationPipe so the
// trivial string-shape / non-empty / length failures surface as HTTP
// 400 VALIDATION_ERROR. override_type's closed-list check is
// INTENTIONALLY NOT a @IsEnum decorator here: an out-of-list value
// must surface as HTTP 422 OVERRIDE_INVALID per directive §4.9 (the
// directive-mandated code/status pair), not as class-validator's
// VALIDATION_ERROR 400. The controller's step 4 manual check (mirroring
// M4 PR-4 ATTESTATION_MISSING's bypass) throws the directive code
// directly. Same architectural pattern, different code: where PR-4
// avoids @Equals(true) to control the attestation refusal code, PR-5
// avoids @IsEnum to control the override-type refusal code.

const VALID_OVERRIDE_TYPES: ReadonlyArray<OverrideTypeValue> = [
  'tier',
  'risk_flag',
  'gap',
  'constraint_check',
];

export function isOverrideTypeValue(v: unknown): v is OverrideTypeValue {
  return (
    typeof v === 'string' && (VALID_OVERRIDE_TYPES as readonly string[]).includes(v)
  );
}

export class CreateOverrideRequestDto {
  // No @IsEnum here — see header. override_type's closed-list check is
  // performed at the controller boundary so the refusal surfaces as
  // OVERRIDE_INVALID 422 instead of VALIDATION_ERROR 400.
  @IsString()
  @IsNotEmpty()
  override_type!: OverrideTypeValue;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  target_field!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  justification!: string;
}

// ExaminationOverrideView — the read boundary type for ExaminationOverride
// rows. Mirrors the OpenAPI ExaminationOverride schema (8 fields) and is
// produced by the repository's projection helper. Re-exported here so
// callers consume a single namespace; the value type also lives in
// examination.repository.ts where the projection helper is defined.
export interface ExaminationOverrideView {
  id: string;
  tenant_id: string;
  examination_id: string;
  override_type: OverrideTypeValue;
  target_field: string;
  justification: string;
  created_by: string;
  // ISO 8601 timestamp (Z-suffixed). Z-faithful to the OpenAPI
  // ExaminationOverride.created_at format: date-time field.
  created_at: string;
}

// CreateOverrideResponseDto — 201 response shape.
//
// examination_mutated is locked to `false`: the directive §4.4 step 8
// requires the controller to emit the literal value, and the OpenAPI
// schema in openapi/common.yaml enforces `const: false`. The boolean
// literal type carries the same invariant at compile time.
export interface CreateOverrideResponseDto {
  override: ExaminationOverrideView;
  examination_mutated: false;
}
