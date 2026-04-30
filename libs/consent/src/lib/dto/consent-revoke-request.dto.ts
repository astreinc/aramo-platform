import { Type } from 'class-transformer';
import {
  IsDateString,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';

import {
  CONSENT_CAPTURED_METHODS,
  CONSENT_SCOPES,
  type ConsentCapturedMethodValue,
  type ConsentScopeValue,
} from './consent-grant-request.dto.js';

// Note: NO `action` field. Server sets action = "revoked". Belt-and-suspenders
// alongside the OpenAPI schema's additionalProperties: false and the refusal
// test consent.refusal-action-locked.spec.ts.
//
// Note: NO `expires_at` and NO `consent_text_snapshot` fields. Both are
// grant-time concepts; revocation has neither. Per PR-3 canonical contract.
export class ConsentRevokeRequestDto {
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
  @IsUUID()
  consent_document_id?: string;

  @IsOptional()
  @IsObject()
  @Type(() => Object)
  metadata?: Record<string, unknown>;
}
