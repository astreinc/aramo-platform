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
// CI-B1 (Aramo-CI-Conversation-Intelligence-Directive-v1_2-LOCKED §4) appends the
// three INDEPENDENT conversation-operation scopes (recording, transcription,
// ai_processing). ADD-not-rename; each is evaluated independently (see
// SCOPE_DEPENDENCY_CHAIN — empty prerequisite chains).
export const CONSENT_SCOPES = [
  'profile_storage',
  'resume_processing',
  'matching',
  'contacting',
  'cross_tenant_visibility',
  'recording',
  'transcription',
  'ai_processing',
] as const;
export type ConsentScopeValue = (typeof CONSENT_SCOPES)[number];

export const CONSENT_CAPTURED_METHODS = [
  'self_signup',
  'recruiter_capture',
  'upload_flow',
  'import',
  // Portal P2 P2a (Directive ruling 2) — the portal-actor capture method: a
  // portal user self-servicing their own consent through the passwordless portal.
  // ADD-not-rename to the closed ledger actor vocab. Audit actor_type derives to
  // 'self' (self-directed, like self_signup); the portal specificity lives in this
  // method + the D7 evidence channel='portal'.
  'portal_self_service',
] as const;
export type ConsentCapturedMethodValue = (typeof CONSENT_CAPTURED_METHODS)[number];

// Note: NO `action` field. Server sets action = "granted". This is one of the
// belt-and-suspenders enforcement points (the others are the OpenAPI schema
// `additionalProperties: false` and the refusal test
// consent.refusal-action-locked.spec.ts).
export class ConsentGrantRequestDto {
  @IsUUID()
  talent_record_id!: string;

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
