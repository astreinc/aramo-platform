import { IsIn, IsUUID } from 'class-validator';

// Promotion-Trigger slice-A — the two sourcer-trigger request bodies. The
// subject is addressed by its pre-promotion L2 ref (SOURCED_TALENT ref_id = the
// origin arrival's payload id); tenant comes from the auth context, never the
// body (tenant-wall). ref_type is constrained to the pre-promotion attachment
// points a sourcer would act on.

const SOURCING_REF_TYPES = ['SOURCED_TALENT', 'PERSON_CLUSTER', 'ATS_TALENT_RECORD'] as const;

export class AddToPipelineRequestDto {
  @IsIn(SOURCING_REF_TYPES)
  ref_type!: (typeof SOURCING_REF_TYPES)[number];

  @IsUUID()
  ref_id!: string;

  @IsUUID()
  requisition_id!: string;
}

export class SaveToBenchRequestDto {
  @IsIn(SOURCING_REF_TYPES)
  ref_type!: (typeof SOURCING_REF_TYPES)[number];

  @IsUUID()
  ref_id!: string;
}
