import { IsIn, IsOptional, IsString, IsUUID } from 'class-validator';

// Promotion-Trigger slice-A — the two sourcer-trigger request bodies. ATI-SEP-1
// T10 WP2: the arrival is addressed by its sourced_talent.SourcedTalent id
// (ref_type SOURCED_TALENT — the only remaining ref kind; the retired trust-
// subject PERSON_CLUSTER / ATS_TALENT_RECORD kinds are refused by the pipe).
// Tenant comes from the auth context, never the body (tenant-wall).

const SOURCING_REF_TYPES = ['SOURCED_TALENT'] as const;

export class AddToPipelineRequestDto {
  @IsIn(SOURCING_REF_TYPES)
  ref_type!: (typeof SOURCING_REF_TYPES)[number];

  @IsUUID()
  ref_id!: string;

  @IsUUID()
  requisition_id!: string;

  // ADR-0024 §D11 (PR-4b) — operator override reason code; REQUIRED only when the
  // policy verdict is REQUIRES_OVERRIDE (closed-set check at the controller
  // boundary → OVERRIDE_INVALID 422). Optional at the transport layer.
  @IsOptional()
  @IsString()
  override_reason_code?: string;
}

export class SaveToBenchRequestDto {
  @IsIn(SOURCING_REF_TYPES)
  ref_type!: (typeof SOURCING_REF_TYPES)[number];

  @IsUUID()
  ref_id!: string;
}
