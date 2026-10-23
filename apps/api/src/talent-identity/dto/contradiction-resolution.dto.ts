import { IsIn, IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { CONTRADICTION_RESOLUTIONS, type ContradictionResolution } from '@aramo/intelligence-contracts';

// TR-4 B3 → ATI-SEP-1 T10 WP3b — the resolve-contradiction request body. A human
// resolves a standing contradiction in Talent Intelligence with a REASON (R4
// accountability). The assertion id is a path param; the record names the ATS
// reference TI resolves it through (the tenant's own view).
export class ResolveContradictionDto {
  @IsUUID()
  talent_record_id!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(4000)
  reason!: string;

  @IsOptional()
  @IsIn(CONTRADICTION_RESOLUTIONS)
  resolution?: ContradictionResolution;
}
