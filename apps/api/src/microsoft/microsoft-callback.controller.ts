import { BadRequestException, Controller, Get, HttpCode, HttpStatus, Query } from '@nestjs/common';
import { MicrosoftOAuthStateError } from '@aramo/microsoft-graph';

import { MicrosoftAuthorizationOrchestrator } from './microsoft-authorization.orchestrator.js';

// COMM-C2B — the Microsoft OAuth callback (R2). Intentionally NOT behind
// JwtAuthGuard: Microsoft redirects the browser here and the request is
// authenticated by the ENCRYPTED, integrity-protected, TTL-bounded state (it
// carries the tenant + recruiter + connection + PKCE verifier). A tampered,
// forged, or expired state is rejected. No token is ever returned to the browser.
@Controller('v1/integrations/microsoft')
export class MicrosoftCallbackController {
  constructor(private readonly orchestrator: MicrosoftAuthorizationOrchestrator) {}

  @Get('callback')
  @HttpCode(HttpStatus.OK)
  async callback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
  ): Promise<{ provider_identity_id: string; status: string; ms_object_id: string }> {
    if (code === undefined || code.length === 0 || state === undefined || state.length === 0) {
      throw new BadRequestException('microsoft_oauth_callback_invalid');
    }
    try {
      const view = await this.orchestrator.complete(code, state);
      return {
        provider_identity_id: view.provider_identity_id,
        status: view.status,
        ms_object_id: view.ms_object_id,
      };
    } catch (err) {
      if (err instanceof MicrosoftOAuthStateError) {
        // Bad/expired/tampered state — CSRF/replay guard (R2).
        throw new BadRequestException('microsoft_oauth_state_invalid');
      }
      throw err;
    }
  }
}
