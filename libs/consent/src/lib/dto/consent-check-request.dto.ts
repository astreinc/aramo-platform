import { CONTACT_CHANNELS, type ContactChannel } from '@aramo/common';
import { IsIn, IsOptional, IsUUID } from 'class-validator';

import {
  CONSENT_CHECK_OPERATIONS,
  type ConsentCheckOperation,
} from './consent-check-operation.js';

// Request body for POST /v1/consent/check.
// Per Decision B: tenant_id is NOT a body field (resolved from JWT).
// `channel` is conditionally required when the operation maps to contacting
// scope; the resolver enforces conditional presence rather than the DTO,
// because the operation→scope mapping (Decision C) lives in the resolver.
// The DTO accepts channel as optional; the resolver returns a 400
// VALIDATION_ERROR if channel is missing for a contacting operation.
export class ConsentCheckRequestDto {
  @IsUUID()
  talent_id!: string;

  @IsIn(CONSENT_CHECK_OPERATIONS)
  operation!: ConsentCheckOperation;

  @IsOptional()
  @IsIn(CONTACT_CHANNELS)
  channel?: ContactChannel;
}
