import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';
import { AramoError, RequestId } from '@aramo/common';
import { InvitationLifecycleService } from '@aramo/identity';

// Invite-S2 (Pattern-2) — the PUBLIC invitation-acceptance endpoint (§3).
//
// POST /v1/invitations/accept  { token }
//
// DELIBERATELY UN-GUARDED: the invitee has NO JWT yet (they have not signed
// in — acceptance precedes first login). There is NO @UseGuards here — none
// of JwtAuthGuard / EntitlementGuard / RolesGuard — so the endpoint is
// reachable pre-login. It carries no AuthContext and exposes no tenant data
// beyond the accepted tenant_id it returns. The ONLY authority is the
// high-entropy single-use token in the body (hash-matched server-side).
//
// It validates the token, flips the membership INVITED → ACCEPTED, sends the
// acceptance-confirmation email, and returns. It ISSUES NO SESSION and FORCES
// NO SIGN-IN (the ratified 3-state separation) — the confirmation email tells
// the invitee to sign in when ready. Invalid / expired / used / revoked
// tokens surface as a clear 400 VALIDATION_ERROR from the lifecycle service
// (never a 500).
//
// Identity-writes stay in libs/identity: this controller is a thin public
// edge delegating to InvitationLifecycleService.acceptInvitation (exported by
// IdentityModule, which apps/api imports via forRoot).
@Controller('v1/invitations')
export class PublicInvitationController {
  constructor(private readonly invitations: InvitationLifecycleService) {}

  @Post('accept')
  @HttpCode(HttpStatus.OK)
  async accept(
    @Body() body: unknown,
    @RequestId() requestId: string,
  ): Promise<{ status: string; tenant_id: string }> {
    const token = parseAcceptBody(body, requestId);
    return this.invitations.acceptInvitation({
      raw_token: token,
      request_id: requestId,
    });
  }
}

function parseAcceptBody(body: unknown, requestId: string): string {
  if (typeof body !== 'object' || body === null) {
    throw new AramoError('VALIDATION_ERROR', 'request body required', 400, {
      requestId,
      details: { reason: 'missing_body' },
    });
  }
  const token = (body as Record<string, unknown>)['token'];
  if (typeof token !== 'string' || token.trim().length === 0) {
    throw new AramoError(
      'VALIDATION_ERROR',
      'token is required',
      400,
      { requestId, details: { reason: 'missing_token' } },
    );
  }
  return token;
}
