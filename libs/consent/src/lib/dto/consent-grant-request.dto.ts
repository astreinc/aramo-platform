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
//
// PROFILE_CONSENT_SCOPES — the talent-facing consent matrix surfaced by
// /consent/state (resolveAllScopes) and the portal consent-text flow. This is the
// pre-CI-B1 five-scope set; its shape is the ats-web/portal consumer contract.
export const PROFILE_CONSENT_SCOPES = [
  'profile_storage',
  'resume_processing',
  'matching',
  'contacting',
  'cross_tenant_visibility',
] as const;
// CI-B1 (Aramo-CI-Conversation-Intelligence-Directive-v1_2-LOCKED §4) — the three
// INDEPENDENT conversation-operation scopes. ADD-not-rename; each is evaluated
// independently (SCOPE_DEPENDENCY_CHAIN — empty prerequisite chains). Governed via
// /consent/check; NOT part of the /consent/state profile matrix (their UI surfaces
// in a later CI seam), so adding them does not change the existing state contract.
export const CONVERSATION_OPERATION_SCOPES = [
  'recording',
  'transcription',
  'ai_processing',
] as const;
// Full grantable/checkable scope vocabulary (mirrors openapi/common.yaml ConsentScope).
export const CONSENT_SCOPES = [
  ...PROFILE_CONSENT_SCOPES,
  ...CONVERSATION_OPERATION_SCOPES,
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

// CONSENT-RECRUITER-CREATE-DEFAULT-1 (Amendment v1.0 LOCKED §3.3) — the LEDGER
// method vocabulary: every HTTP-acceptable method above PLUS the server-only
// `recruiter_create_default` (the at-create contact-consent grant recorded when a
// recruiter creates a Talent). Deliberately NOT added to CONSENT_CAPTURED_METHODS:
// that list backs the HTTP grant/revoke request validation (@IsIn) and the openapi
// ConsentCapturedMethod enum, and the amendment forbids exposing this method to any
// HTTP request enum. captured_method is TEXT in the DB (no migration). The resolver
// partitions by captured_method string, so the new method is its own partition and
// the most-restrictive rule across partitions still lets any revocation deny.
export const CONSENT_LEDGER_CAPTURED_METHODS = [
  ...CONSENT_CAPTURED_METHODS,
  'recruiter_create_default',
] as const;
export type ConsentLedgerCapturedMethodValue =
  (typeof CONSENT_LEDGER_CAPTURED_METHODS)[number];

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
