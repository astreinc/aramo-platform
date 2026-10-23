import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { RequestId } from '@aramo/common';
import { RequireScopes, RolesGuard } from '@aramo/authorization';
import { EntitlementGuard, RequireCapability } from '@aramo/entitlement';

import { RequestEmailVerificationDto } from './dto/email-verification.dto.js';
import {
  EmailVerificationService,
  type EmailVerificationStatusResponse,
  type RequestVerificationResult,
} from './email-verification.service.js';

// TR-3 B2 → ATI-SEP-1 T10 WP3b (A3 T10-3) — the AUTHENTICATED recruiter surface
// for email verification, executed by Talent Intelligence as a 6-digit code. Nested under the talent-record resource (the record is the
// subject of the action). Class-gated to the ATS capability; the request is a
// write-shaped contact-initiation (talent:edit), the status a read
// (talent:read). tenant + actor come ONLY from the JWT — never a body/param.
//
// The PUBLIC confirm route is a SEPARATE, un-guarded controller
// (PublicVerificationController) — the talent has no session.
@Controller('v1/talent-records/:recordId/email-verifications')
@UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
@RequireCapability('ats')
export class EmailVerificationController {
  constructor(private readonly service: EmailVerificationService) {}

  // POST — request a one-time code for a STORED slot (email1|email2). The DTO
  // admits no free-form address (acceptance (c)). TI not enabled / down → 503
  // INTELLIGENCE_UNAVAILABLE (details.intelligence_status).
  @Post()
  @HttpCode(HttpStatus.OK)
  @RequireScopes('talent:edit')
  async request(
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
    @Param('recordId') recordId: string,
    @Body() body: RequestEmailVerificationDto,
  ): Promise<RequestVerificationResult> {
    return this.service.requestVerification({
      recordId,
      slot: body.slot,
      authContext,
      requestId,
    });
  }

  // GET — per-slot verification status (verified/pending/none) for the
  // record-detail surface, fail-soft (intelligence_status). Words, never numbers.
  @Get()
  @HttpCode(HttpStatus.OK)
  @RequireScopes('talent:read')
  async status(
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
    @Param('recordId') recordId: string,
  ): Promise<EmailVerificationStatusResponse> {
    return this.service.getStatus({ recordId, authContext, requestId });
  }
}
