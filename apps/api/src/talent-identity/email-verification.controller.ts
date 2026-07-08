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
  type EmailSlotStatusView,
  type RequestVerificationResult,
} from './email-verification.service.js';

// TR-3 B2 (§3.1/§3.3) — the AUTHENTICATED recruiter surface for email
// verification. Nested under the talent-record resource (the record is the
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

  // POST — request a verification email for a STORED slot (email1|email2). The
  // DTO admits no free-form address (acceptance (c)). Idempotent-return +
  // resend-rotate on a repeat while one is open (acceptance (d)).
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

  // GET — per-slot verification status (pending/verified/expired/none) for the
  // record-detail surface. Bands, never scores (R10).
  @Get()
  @HttpCode(HttpStatus.OK)
  @RequireScopes('talent:read')
  async status(
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
    @Param('recordId') recordId: string,
  ): Promise<{ items: EmailSlotStatusView[] }> {
    return this.service.getStatus({ recordId, authContext, requestId });
  }
}
