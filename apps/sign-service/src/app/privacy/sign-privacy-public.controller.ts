import { Body, Controller, HttpCode, HttpStatus, Post, Req, UseFilters } from '@nestjs/common';
import { AramoExceptionFilter, RequestId } from '@aramo/common';
import type { Request } from 'express';

import { clientIp } from '../personal/personal-send.gate.js';

import { SignPrivacyRequestService, type SignPrivacyRequestView } from './sign-privacy-request.service.js';

// Aramo-Sign-Mobile-Amendment-M-A7 §3.3 — the PUBLIC privacy-request flow behind
// https://sign.aramo.ai/delete-account (no app, no sign-in):
//
//   POST /v1/sign/privacy-requests/start   { email, request_type? } → 202 { received: true }
//        always the same answer (no account enumeration); a one-time link is emailed
//   POST /v1/sign/privacy-requests/verify  { token } → the request (reference + status)
//        the token comes from the link's URL FRAGMENT and travels only in this body
//   POST /v1/sign/privacy-requests/status  { reference, email } → the request, or 404
//
// Budgeted per client address in the service and at the nginx edge.

@Controller('v1/sign/privacy-requests')
@UseFilters(AramoExceptionFilter)
export class SignPrivacyPublicController {
  constructor(private readonly privacy: SignPrivacyRequestService) {}

  @Post('start')
  @HttpCode(HttpStatus.ACCEPTED)
  start(@Body() body: { email?: unknown; request_type?: unknown }, @Req() req: Request, @RequestId() requestId: string): Promise<{ received: true }> {
    return this.privacy.startWeb(body ?? {}, clientIp(req), requestId);
  }

  @Post('verify')
  @HttpCode(HttpStatus.OK)
  verify(@Body() body: { token?: unknown }, @Req() req: Request, @RequestId() requestId: string): Promise<SignPrivacyRequestView> {
    return this.privacy.verifyWeb(body ?? {}, clientIp(req), requestId);
  }

  @Post('status')
  @HttpCode(HttpStatus.OK)
  status(@Body() body: { reference?: unknown; email?: unknown }, @Req() req: Request, @RequestId() requestId: string): Promise<SignPrivacyRequestView> {
    return this.privacy.statusWeb(body ?? {}, clientIp(req), requestId);
  }
}
