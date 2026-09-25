import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsIn,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import {
  CLIENT_SUBMITTAL_POLICY_SCOPES,
  CLIENT_SUBMITTAL_REQUIREMENT_KEYS,
  DISPOSITION_VALUES,
  OVERRIDE_CLASS_VALUES,
  OVERRIDE_POLICY_VALUES,
} from '@aramo/client-submittal-policy';

// CSP PR-2 — HTTP request DTOs for the Client Submittal Policy admin surface. Every
// enum is validated against the closed lib registries (an out-of-list value is a
// 422 domain error, never free text introducing executable semantics).
export class ClientSubmittalRequirementDto {
  @IsIn(CLIENT_SUBMITTAL_REQUIREMENT_KEYS as readonly string[])
  key!: string;

  @IsIn(DISPOSITION_VALUES as readonly string[])
  disposition!: string;

  @IsIn(OVERRIDE_CLASS_VALUES as readonly string[])
  override_class!: string;

  // Optional; absent = DEFAULT. FLOOR marks a non-relaxable requirement.
  @IsOptional()
  @IsIn(OVERRIDE_POLICY_VALUES as readonly string[])
  override_policy?: string;
}

export class PublishClientSubmittalPolicyDto {
  @IsIn(CLIENT_SUBMITTAL_POLICY_SCOPES as readonly string[])
  scope!: string;

  // Required for CLIENT (an owned company_id, ownership-verified) and REQUISITION (a
  // requisition_id); absent for TENANT (server-derives scope_ref = tenant_id).
  @IsOptional()
  @IsUUID()
  scope_ref?: string;

  @IsString()
  @IsNotEmpty()
  version!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ClientSubmittalRequirementDto)
  requirements!: ClientSubmittalRequirementDto[];

  @IsOptional()
  @IsISO8601()
  effective_from?: string;
}
