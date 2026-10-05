import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { AramoError, RequestId } from '@aramo/common';
import { RequireScopes, RolesGuard } from '@aramo/authorization';
import { EntitlementGuard, RequireCapability } from '@aramo/entitlement';

import { TalentEmailUnavailableError } from '../microsoft/email-recipient-resolver.port.js';

import { GeneralTalentContactDraftRequestDto } from './dto/general-talent-contact-draft.dto.js';
import { TalentContactContextError } from './talent-contact-context.error.js';
import {
  GeneralTalentContactDraftService,
  type GeneralTalentContactDraftView,
} from './general-talent-contact-draft.service.js';

// COMM-RECRUITER-W1 (W1-A2) — prepares a REVIEWABLE General Talent Contact email
// draft. Talent-only: no requisition. WRITES NOTHING (no Graph, no
// CommunicationInteraction, no pipeline). Same three-axis authorization + the SAME
// send scope (drafting is a send-precursor) as requisition-contact; recipient is
// server-resolved and display-only.
@Controller('v1/communications/email-drafts')
@UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
@RequireCapability('ats')
export class GeneralTalentContactDraftController {
  constructor(private readonly drafts: GeneralTalentContactDraftService) {}

  @Post('general-contact')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('communication:email:send')
  async prepare(
    @AuthContext() auth: AuthContextType,
    @Body() body: GeneralTalentContactDraftRequestDto,
    @RequestId() requestId: string,
  ): Promise<GeneralTalentContactDraftView> {
    try {
      return await this.drafts.prepareDraft({
        tenant_id: auth.tenant_id,
        recruiter_id: auth.sub,
        talent_record_id: body.talent_record_id,
      });
    } catch (err) {
      throw this.mapError(err, requestId);
    }
  }

  private mapError(err: unknown, requestId: string): AramoError {
    if (err instanceof TalentContactContextError) {
      return new AramoError(
        'TALENT_CONTACT_CONTEXT_INVALID',
        'general talent contact draft context invalid',
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
    throw err;
  }
}
