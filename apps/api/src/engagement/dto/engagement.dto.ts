import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

// COMM-C3 — publish-a-policy request DTO (R5/R16). Provider-neutral typed
// requirement registry; NO provider/vendor key may appear. class-validator gives
// the first structural gate; the Engagement domain re-validates + activation-guards.

export class VoiceRequirementDto {
  @IsIn(['voice']) channel!: 'voice';
  @IsBoolean() required!: boolean;
  @IsIn(['two_way_conversation']) condition!: 'two_way_conversation';
  @IsIn(['RECRUITER_ATTESTED', 'PROVIDER_VERIFIED']) minimum_strength!:
    | 'RECRUITER_ATTESTED'
    | 'PROVIDER_VERIFIED';
}

export class EmailRequirementDto {
  @IsIn(['email']) channel!: 'email';
  @IsBoolean() required!: boolean;
  @IsIn(['recorded_evidence']) condition!: 'recorded_evidence';
}

export class PublishEngagementPolicyRequestDto {
  @IsString() @MaxLength(64) version!: string;
  @IsIn(['TENANT', 'CLIENT', 'REQUISITION']) scope!: 'TENANT' | 'CLIENT' | 'REQUISITION';
  @IsOptional() @IsUUID() scope_ref?: string | null;
  @IsInt() schema_version!: number;
  @IsArray()
  @ArrayMaxSize(8)
  @ValidateNested({ each: true })
  @Type(() => Object)
  requirements!: Array<VoiceRequirementDto | EmailRequirementDto>;
  @IsOptional() @IsString() effective_from?: string;
}
