import { Body, Controller, HttpCode, HttpStatus, Ip, Post } from '@nestjs/common';
import { RequestId } from '@aramo/common';

import {
  DomainVerificationDelegationService,
  type DelegateView,
} from './domain-verification-delegation.service.js';

// Domain-Enforcement P3 (LOCKED) §5 — the delegate link's session-less surface.
//
//   POST /v1/domain-verification/delegate        { token } → { domain, record, status, … }
//   POST /v1/domain-verification/delegate/check  { token } → runs the P2b check
//
// DELIBERATELY UN-GUARDED (the public-invitation / email-verification precedent):
// the IT administrator has no Aramo account. The ONLY authority is the
// high-entropy token, which travels in the link's URL fragment and is posted in
// the BODY (never a URL path or query). Hash-matched server-side; unknown /
// expired / revoked / malformed / over-budget all return the same 404.
//
// The grant is narrow by construction: tenant_id comes from the delegation row,
// and the two handlers can only read the record and run the check for that one
// tenant. No membership, scope, billing, Sign or administrative access is created,
// and the P2b token is never rotated here.
//
// Both handlers are POST because the token is a body field (P3 §5 names the read
// "GET /v1/domain-verification/delegate"; a GET cannot carry the body the same
// section requires — recorded as a divergence in the delivery report).
@Controller('v1/domain-verification/delegate')
export class DomainVerificationDelegateController {
  constructor(private readonly delegations: DomainVerificationDelegationService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  async view(
    @Body() body: unknown,
    @Ip() ip: string,
    @RequestId() requestId: string,
  ): Promise<DelegateView> {
    return this.delegations.delegateView(body, ip ?? 'unknown', requestId);
  }

  @Post('check')
  @HttpCode(HttpStatus.OK)
  async check(
    @Body() body: unknown,
    @Ip() ip: string,
    @RequestId() requestId: string,
  ): Promise<DelegateView> {
    return this.delegations.delegateCheck(body, ip ?? 'unknown', requestId);
  }
}
