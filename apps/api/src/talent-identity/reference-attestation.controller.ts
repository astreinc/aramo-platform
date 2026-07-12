import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { RequestId } from '@aramo/common';
import { RequireScopes, RolesGuard } from '@aramo/authorization';
import { EntitlementGuard, RequireCapability } from '@aramo/entitlement';

import { RecordReferenceAttestationDto } from './dto/reference-attestation.dto.js';
import {
  ReferenceAttestationService,
  type RecordReferenceResult,
} from './reference-attestation.service.js';

// TR-9 B1 (D5) — the AUTHENTICATED recruiter surface for recording a reference.
// Nested under the talent-record resource (the record is the subject of the
// action), gated exactly as email-verification: capability `ats` + scope
// `talent:edit` (recording a reference IS editing the record's evidence). The
// platform contacts no one — this captures a reference the recruiter already
// lawfully holds, under the tenant's existing basis. tenant + actor come ONLY
// from the JWT. Idempotent-return: the same reference recorded twice is one row.
@Controller('v1/talent-records/:recordId/reference-attestations')
@UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
@RequireCapability('ats')
export class ReferenceAttestationController {
  constructor(private readonly service: ReferenceAttestationService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('talent:edit')
  async record(
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
    @Param('recordId', ParseUUIDPipe) recordId: string,
    @Body() body: RecordReferenceAttestationDto,
  ): Promise<RecordReferenceResult> {
    // A missing record → 404; a superseded record → 422 TALENT_RECORD_SUPERSEDED;
    // a malformed payload → 422 CLAIM_SHAPE_INVALID (the trust write gate).
    return this.service.recordReference({ recordId, dto: body, authContext, requestId });
  }
}
