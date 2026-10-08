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
  // The requirement array is a `channel`-discriminated union. `@Type(() => Object)`
  // would deserialize each element to a bare Object with NO class-validator
  // metadata, so under the global pipe's `forbidNonWhitelisted` EVERY property
  // (channel/required/condition) is rejected as "should not exist" (HTTP 400) —
  // i.e. every real publish fails. Mapping each element to its concrete Voice/
  // Email DTO via the `channel` discriminator whitelists the nested props; the
  // Engagement domain then re-validates + activation-guards the resolved shape.
  @Type(() => Object, {
    keepDiscriminatorProperty: true,
    discriminator: {
      property: 'channel',
      subTypes: [
        { value: VoiceRequirementDto, name: 'voice' },
        { value: EmailRequirementDto, name: 'email' },
      ],
    },
  })
  requirements!: Array<VoiceRequirementDto | EmailRequirementDto>;
  @IsOptional() @IsString() effective_from?: string;
  // PART A — how the policy applies at submit. OPTIONAL (A2): an absent mode is
  // persisted as absent and resolves to ENFORCING (never ADVISORY) at read time.
  @IsOptional()
  @IsIn(['ADVISORY', 'ENFORCING', 'ENFORCING_WITH_OVERRIDE'])
  enforcement_mode?: 'ADVISORY' | 'ENFORCING' | 'ENFORCING_WITH_OVERRIDE';
}
