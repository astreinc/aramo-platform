import {
  IsBoolean,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

import {
  DECAY_PROFILES,
  METHODS,
  PORTABILITY_CLASSES,
  SOURCE_CLASSES,
  TRUST_DIMENSIONS,
  RESOLUTION_SUBJECT_REF_TYPES,
  type DecayProfile,
  type Method,
  type PortabilityClass,
  type SourceClass,
  type TrustDimension,
  type ResolutionSubjectRefType,
} from '../vocab.js';

// DTO for the §8 recordEvidence write — the closed-vocabulary enforcement
// surface (PO Ruling 2: String columns at the DB layer, @IsIn at the DTO
// layer). TR-1 ships no controller (foundation lib), but the producing slices
// (TR-2…TR-10) validate their recordEvidence calls against this shape, and it
// is the ready surface when an HTTP endpoint is added.
//
// NOTE: assertion_type is deliberately NOT @IsIn-gated — it is extensible
// (§5.3, "later slices register more"); a closed @IsIn list would defeat the
// extensibility. It is validated as a non-empty string only.

export class SubjectRefDto {
  @IsUUID()
  tenant_id!: string;

  @IsIn(RESOLUTION_SUBJECT_REF_TYPES)
  ref_type!: ResolutionSubjectRefType;

  @IsUUID()
  ref_id!: string;

  @IsOptional()
  @IsString()
  link_source?: string;
}

export class RecordEvidenceDto {
  @ValidateNested()
  @Type(() => SubjectRefDto)
  subjectRef!: SubjectRefDto;

  @IsIn(TRUST_DIMENSIONS)
  dimension!: TrustDimension;

  @IsString()
  assertion_type!: string;

  @IsObject()
  assertion_payload!: Record<string, unknown>;

  @IsIn(SOURCE_CLASSES)
  source_class!: SourceClass;

  @IsIn(METHODS)
  method!: Method;

  @IsOptional()
  @IsObject()
  source_ref?: Record<string, unknown> | null;

  @IsIn(PORTABILITY_CLASSES)
  portability_class!: PortabilityClass;

  @IsIn(DECAY_PROFILES)
  decay_profile!: DecayProfile;

  @IsOptional()
  @IsBoolean()
  ai_derived?: boolean;

  @IsString()
  created_by!: string;
}
