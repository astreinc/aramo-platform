import { Type } from 'class-transformer';
import {
  IsDateString,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';

// Closed enums match openapi/common.yaml ConsentScope and ConsentCapturedMethod.
export const CONSENT_SCOPES = [
  'profile_storage',
  'resume_processing',
  'matching',
  'contacting',
  'cross_tenant_visibility',
] as const;
export type ConsentScopeValue = (typeof CONSENT_SCOPES)[number];

export const CONSENT_CAPTURED_METHODS = [
  'self_signup',
  'recruiter_capture',
  'upload_flow',
  'import',
] as const;
export type ConsentCapturedMethodValue = (typeof CONSENT_CAPTURED_METHODS)[number];

// Note: NO `action` field. Server sets action = "granted". This is one of the
// belt-and-suspenders enforcement points (the others are the OpenAPI schema
// `additionalProperties: false` and the refusal test
// consent.refusal-action-locked.spec.ts).
export class ConsentGrantRequestDto {
  @IsUUID()
  talent_id!: string;

  @IsIn(CONSENT_SCOPES)
  scope!: ConsentScopeValue;

  @IsIn(CONSENT_CAPTURED_METHODS)
  captured_method!: ConsentCapturedMethodValue;

  @IsString()
  consent_version!: string;

  @IsDateString()
  occurred_at!: string;

  @IsOptional()
  @IsString()
  consent_text_snapshot?: string;

  @IsOptional()
  @IsUUID()
  consent_document_id?: string;

  @IsOptional()
  @IsDateString()
  expires_at?: string;

  @IsOptional()
  @IsObject()
  @Type(() => Object)
  metadata?: Record<string, unknown>;
}
