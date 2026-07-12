import { Type } from 'class-transformer';
import {
  IsIn,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { STATEMENT_CLASSES } from '@aramo/talent-trust';

// TR-9 B1 (D5) — the recorded-reference capture body. NO rating field
// exists (R10 structural — a reference with a number is a review, not evidence;
// the shape refuses the concept). The service maps this to the ATTESTATION
// canonical shape; the trust write gate is the domain authority (malformed →
// CLAIM_SHAPE_INVALID 422). tenant + actor come ONLY from the JWT.

export class AttesterDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsOptional()
  @IsString()
  email?: string;

  @IsOptional()
  @IsString()
  company?: string;

  @IsOptional()
  @IsString()
  role?: string;
}

export class AttestationPeriodDto {
  @IsOptional()
  @IsString()
  start?: string;

  @IsOptional()
  @IsString()
  end?: string;
}

export class RecordReferenceAttestationDto {
  @IsObject()
  @ValidateNested()
  @Type(() => AttesterDto)
  attester!: AttesterDto;

  @IsString()
  @IsNotEmpty()
  relationship!: string;

  // SKILL | WORK → CLAIMS; TENURE → CONTINUITY (the service maps it).
  @IsString()
  @IsIn(STATEMENT_CLASSES as unknown as string[])
  statement_class!: string;

  @IsString()
  @IsNotEmpty()
  statement!: string;

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => AttestationPeriodDto)
  period?: AttestationPeriodDto;
}
