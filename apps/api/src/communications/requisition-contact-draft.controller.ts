import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { AramoError, RequestId } from '@aramo/common';
import { RequireScopes, RolesGuard } from '@aramo/authorization';
import { EntitlementGuard, RequireCapability } from '@aramo/entitlement';

import { RequisitionContactEmailDraftRequestDto } from './dto/requisition-contact-draft.dto.js';
import { RequisitionContactContextError } from './requisition-contact-context.error.js';
import {
  RequisitionContactDraftService,
  type RequisitionContactDraftView,
} from './requisition-contact-draft.service.js';
import { TalentEmailUnavailableError } from '../microsoft/email-recipient-resolver.port.js';

// COMM-C4 (RCE-1) — prepares a REVIEWABLE requisition-contact email draft. This
// endpoint WRITES NOTHING: no Graph send, no CommunicationInteraction, no
// pipeline mutation, no idempotency. Same three-axis authorization + scope as
// the send (drafting is a send-precursor); the recruiter/tenant come from the
// JWT, never the body. The recipient is server-resolved and display-only.
@Controller('v1/communications/email-drafts')
@UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
@RequireCapability('ats')
export class RequisitionContactDraftController {
  constructor(private readonly drafts: RequisitionContactDraftService) {}

  @Post('requisition-contact')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('communication:email:send')
  async prepare(
    @AuthContext() auth: AuthContextType,
    @Body() body: RequisitionContactEmailDraftRequestDto,
    @RequestId() requestId: string,
  ): Promise<RequisitionContactDraftView> {
    try {
      return await this.drafts.prepareDraft({
        tenant_id: auth.tenant_id,
        recruiter_id: auth.sub,
        talent_record_id: body.talent_record_id,
        requisition_id: body.requisition_id,
        pipeline_id: body.pipeline_id,
      });
    } catch (err) {
      throw this.mapError(err, requestId);
    }
  }

  private mapError(err: unknown, requestId: string): AramoError {
    if (err instanceof RequisitionContactContextError) {
      return new AramoError(
        'COMMUNICATION_REQUISITION_CONTACT_CONTEXT_INVALID',
        'requisition-contact draft context invalid',
        422,
        { requestId, details: { reason: err.reason } },
      );
    }
    if (err instanceof TalentEmailUnavailableError) {
      return new AramoError(
        'COMMUNICATION_EMAIL_RECIPIENT_UNAVAILABLE',
        'the Talent has no authoritative email for send',
        422,
        { requestId },
      );
    }
    if (err instanceof AramoError) return err;
    // Unexpected — let the global exception filter map it to 500.
    throw err;
  }
}
