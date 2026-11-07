import { Controller, Get, UseFilters } from '@nestjs/common';
import { AramoExceptionFilter, RequestId } from '@aramo/common';
import { AuthContext, type AuthContextType } from '@aramo/auth';

import { RecipientInboxBoundary } from '../../inbox/recipient-inbox.controller.js';
import { senderHttp } from '../../sender/envelope-contracts.js';

import { SignMeSigningStatsService } from './sign-me-signing-stats.service.js';

// Aramo Sign Mobile M-A14 R-4 — GET /v1/sign/me/signing-stats: the signed-in user's own
// documents_signed and pages_signed. Same per-user zone as /v1/sign/me/settings and the inbox:
// the session + the `sign` consumer, no Sign role scope; keyed by the token's (tenant, subject).
@Controller('v1/sign/me')
@UseFilters(AramoExceptionFilter)
export class SignMeSigningStatsController {
  constructor(private readonly stats: SignMeSigningStatsService) {}

  @Get('signing-stats')
  @RecipientInboxBoundary()
  async signingStats(@AuthContext() auth: AuthContextType, @RequestId() requestId: string) {
    try {
      return await this.stats.stats(auth);
    } catch (e) {
      throw senderHttp(e, requestId);
    }
  }
}
